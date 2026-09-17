/**
 * Throwaway: proves the video path end to end in a real browser — decode in
 * the worker, planes uploaded as textures, both fields drawn through the
 * deinterlace shader — using the committed fixture, with no device involved.
 *
 * Served by `vite dev` at /probe.html.
 */
import { createRenderer } from "./lib/wasmlive/deinterlace";
import { createPresenter } from "./lib/wasmlive/presenter";
import type { DecodedVideoFrame } from "./lib/wasmlive/types";
import type { FromWorker } from "./lib/wasmlive/workerProtocol";
// The test fixture, imported rather than copied into public/ — nothing here is
// part of the production build, and a megabyte of TS should not ship with it.
import fixtureUrl from "./lib/wasmlive/__fixtures__/1080i-1s.ts.bin?url";

const out = document.getElementById("out") as HTMLPreElement;
const canvas = document.getElementById("screen") as HTMLCanvasElement;
const lines: string[] = [];
const say = (s: string) => { lines.push(s); out.textContent = lines.join("\n"); };

const renderer = createRenderer(canvas);
say("renderer: webgl2 context created");

let clock = 0;
const presenter = createPresenter({
  now: () => clock,
  upload: (frame) => renderer.upload(frame),
  draw: (field) => renderer.drawField(field.parity, field.interlaced),
});

const worker = new Worker(new URL("./lib/wasmlive/decode.worker.ts", import.meta.url), {
  type: "module",
});

const frames: DecodedVideoFrame[] = [];
let audioChunks = 0;

worker.onmessage = (event: MessageEvent<FromWorker>) => {
  const message = event.data;
  if (message.type === "opened") say("worker: decoder opened");
  if (message.type === "video") {
    for (const frame of message.frames) frames.push(frame);
  }
  if (message.type === "audio") audioChunks += message.chunks.length;
  if (message.type === "error") say(`worker ERROR: ${message.message}`);
};

worker.postMessage({ type: "open" });

const response = await fetch(fixtureUrl);
const bytes = new Uint8Array(await response.arrayBuffer());
say(`fixture: ${(bytes.length / 1024).toFixed(0)} KB`);

for (let at = 0; at < bytes.length; at += 64 * 1024) {
  const slice = bytes.slice(at, Math.min(at + 64 * 1024, bytes.length));
  worker.postMessage({ type: "segment", bytes: slice.buffer }, [slice.buffer]);
}

await new Promise((resolve) => setTimeout(resolve, 3000));

say(`decoded: ${frames.length} video frames, ${audioChunks} audio chunks`);
if (!frames.length) {
  say("NO FRAMES — nothing further to draw");
} else {
  const first = frames[0];
  say(`first frame: ${first.width}x${first.height}, ${first.data.length} bytes, ` +
      `interlaced=${first.interlaced} tff=${first.topFieldFirst} ` +
      `pts=${first.ptsSeconds.toFixed(3)} dur=${first.durationSeconds.toFixed(5)}`);

  // Three frames, not thirty: the queue caps at 8 field presentations, so
  // offering everything at once evicts the frames the clock is about to reach
  // and presents nothing.
  for (const frame of frames.slice(0, 3)) presenter.offer(frame);
  say(`queued ${presenter.queued} field presentations`);

  const start = frames[0].ptsSeconds;
  const step = frames[0].durationSeconds / 2;
  say("ticking…");
  try {
    for (let i = 0; i < 6; i++) {
      clock = start + i * step;
      presenter.tick();
      await new Promise((resolve) => setTimeout(resolve, 16));
    }
  } catch (e) {
    say(`TICK THREW: ${e instanceof Error ? e.message : String(e)}`);
  }
  say(`presented ${presenter.presentedCount} fields, ${presenter.queued} still queued`);

  // Read a pixel back: a canvas that looks black and a canvas that is black
  // are not the same thing, and only one of them is a bug.
  const gl = (canvas.getContext("webgl2") as WebGL2RenderingContext | null);
  if (gl) {
    const pixel = new Uint8Array(4);
    gl.readPixels(
      Math.floor(canvas.width / 2), Math.floor(canvas.height / 2),
      1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel,
    );
    say(`centre pixel: rgba(${pixel.join(", ")})`);
    say(`canvas backing store: ${canvas.width}x${canvas.height}`);
  }
}
