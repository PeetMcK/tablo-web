/**
 * Deinterlace and colour conversion, on the GPU, in one pass.
 *
 * This exists because Phase 0 measured the alternative: `bwdif` inside the
 * WASM build runs at 0.82x realtime — it is hand-written AVX2 natively and
 * this build has no SIMD — while decode alone clears 8.8x. Every per-pixel
 * operation therefore belongs here, where a 1080p frame costs a GPU nothing.
 *
 * The frame arrives as planar I420. Three `R8` textures carry Y, U and V; the
 * fragment shader samples the field being shown, interpolates the lines that
 * field does not have, and converts BT.709 YUV to RGB before it writes. No
 * pixel is ever touched by JavaScript.
 *
 * v1 interpolates within the current field only — a bob with vertical
 * filtering. It cannot smear (nothing from another moment in time is mixed in)
 * and it cannot comb (the other field is never sampled). What it costs is
 * vertical detail on static areas, where a motion-adaptive version would keep
 * both fields. That version replaces `FRAGMENT_SHADER` and nothing else: the
 * uniforms it would need — the previous frame's textures — are the only
 * addition, and the presenter already uploads frame by frame.
 */

import type { DecodedVideoFrame, FieldParity } from "./types";

const VERTEX_SHADER = `#version 300 es
in vec2 position;
out vec2 uv;
void main() {
  // A single triangle covering the viewport, with uv flipped vertically:
  // video rows run top-down, GL's clip space runs bottom-up.
  uv = vec2((position.x + 1.0) * 0.5, 1.0 - (position.y + 1.0) * 0.5);
  gl_Position = vec4(position, 0.0, 1.0);
}`;

const FRAGMENT_SHADER = `#version 300 es
precision mediump float;

in vec2 uv;
out vec4 color;

uniform sampler2D planeY;
uniform sampler2D planeU;
uniform sampler2D planeV;
/** Picture height in lines, so a row index can be recovered from uv. */
uniform float height;
/** 0 = top field (even lines), 1 = bottom field (odd lines). */
uniform float fieldOffset;
/** 0 for progressive frames, which are drawn exactly as decoded. */
uniform float interlaced;

float luma(float row) {
  return texture(planeY, vec2(uv.x, (row + 0.5) / height)).r;
}

void main() {
  float row = floor(uv.y * height);

  float y;
  if (interlaced < 0.5) {
    y = luma(row);
  } else {
    // Lines belonging to this field are taken as they are. The lines between
    // them belong to the other moment in time, so they are rebuilt from this
    // field's neighbours rather than shown.
    float parity = mod(row, 2.0);
    if (abs(parity - fieldOffset) < 0.5) {
      y = luma(row);
    } else {
      float above = max(row - 1.0, fieldOffset);
      float below = min(row + 1.0, height - 2.0 + fieldOffset);
      y = 0.5 * (luma(above) + luma(below));
    }
  }

  // Chroma is half resolution in both directions and changes slowly; sampling
  // it linearly at the pixel's own position is enough, and interpolating it
  // per field would buy nothing visible.
  float u = texture(planeU, uv).r - 0.5;
  float v = texture(planeV, uv).r - 0.5;

  // BT.709, limited range: broadcast HD.
  float yy = (y - 0.0625) * 1.164383;
  color = vec4(
    yy + 1.792741 * v,
    yy - 0.213249 * u - 0.532909 * v,
    yy + 2.112402 * u,
    1.0
  );
}`;

export interface Renderer {
  /** Put a decoded frame's three planes on the GPU. */
  upload(frame: DecodedVideoFrame): void;
  /** Draw one field of whatever was last uploaded. */
  drawField(parity: FieldParity, interlaced: boolean): void;
  destroy(): void;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(shader);
    gl.deleteShader(shader);
    throw new Error(`shader failed to compile: ${log}`);
  }
  return shader;
}

function makePlane(gl: WebGL2RenderingContext, unit: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("could not create texture");
  gl.activeTexture(gl.TEXTURE0 + unit);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

export function createRenderer(canvas: OffscreenCanvas | HTMLCanvasElement): Renderer {
  const gl = canvas.getContext("webgl2", {
    alpha: false,
    antialias: false,
    // The page composites each field as it is drawn; without this the browser
    // clears the drawing buffer between frames and the picture flickers.
    preserveDrawingBuffer: false,
    desynchronized: true,
  }) as WebGL2RenderingContext | null;
  if (!gl) throw new Error("webgl2 unavailable");

  const program = gl.createProgram();
  if (!program) throw new Error("could not create program");
  gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
  gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    throw new Error(`program failed to link: ${gl.getProgramInfoLog(program)}`);
  }
  gl.useProgram(program);

  // One triangle rather than two: it covers the viewport with no seam down
  // the diagonal and one fewer vertex to think about.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);

  const textures = [makePlane(gl, 0), makePlane(gl, 1), makePlane(gl, 2)];
  gl.uniform1i(gl.getUniformLocation(program, "planeY"), 0);
  gl.uniform1i(gl.getUniformLocation(program, "planeU"), 1);
  gl.uniform1i(gl.getUniformLocation(program, "planeV"), 2);
  const heightUniform = gl.getUniformLocation(program, "height");
  const fieldUniform = gl.getUniformLocation(program, "fieldOffset");
  const interlacedUniform = gl.getUniformLocation(program, "interlaced");

  let width = 0;
  let height = 0;

  /** Rows come packed to the byte, not to GL's default 4-byte alignment. */
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);

  const resize = (w: number, h: number) => {
    width = w;
    height = h;
    canvas.width = w;
    canvas.height = h;
    gl.viewport(0, 0, w, h);
    gl.uniform1f(heightUniform, h);
  };

  return {
    upload(frame: DecodedVideoFrame) {
      if (frame.width !== width || frame.height !== height) {
        resize(frame.width, frame.height);
      }

      const lumaSize = frame.width * frame.height;
      const chromaWidth = frame.width >> 1;
      const chromaHeight = frame.height >> 1;
      const chromaSize = chromaWidth * chromaHeight;

      const planes: [Uint8Array, number, number][] = [
        [frame.data.subarray(0, lumaSize), frame.width, frame.height],
        [frame.data.subarray(lumaSize, lumaSize + chromaSize), chromaWidth, chromaHeight],
        [frame.data.subarray(lumaSize + chromaSize), chromaWidth, chromaHeight],
      ];

      for (let i = 0; i < planes.length; i++) {
        const [pixels, w, h] = planes[i];
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, textures[i]);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, pixels);
      }
    },

    drawField(parity: FieldParity, interlaced: boolean) {
      gl.uniform1f(fieldUniform, parity === "top" ? 0 : 1);
      gl.uniform1f(interlacedUniform, interlaced ? 1 : 0);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    },

    destroy() {
      for (const texture of textures) gl.deleteTexture(texture);
      gl.deleteBuffer(buffer);
      gl.deleteProgram(program);
    },
  };
}
