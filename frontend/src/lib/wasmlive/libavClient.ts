/**
 * The only module that knows libav.js exists.
 *
 * Bytes in, decoded frames and PCM out. Everything libav-shaped — reader
 * devices, format contexts, filter graphs, packet and frame pointers — stops
 * here, so the rest of the pipeline is ordinary TypeScript and the version pin
 * has exactly one blast radius.
 *
 * No video filter runs. Phase 0 measured `bwdif` in this build at 0.82x
 * realtime against 8.8x for the decoder alone, so frames leave here still
 * interlaced and the GPU does the deinterlace. What this module owes the
 * shader is the field metadata: whether a frame is interlaced, which field
 * leads, and how long the frame lasts.
 *
 * Reading runs as a pump rather than a call per chunk. libav's reader device
 * blocks until it is given data, and "no data right now" is not the same as
 * "end of file" — answering an empty queue with EOF makes the demuxer probe
 * whatever happened to have arrived, which was enough to lose the audio stream
 * entirely ("Could not find codec parameters ... unspecified sample rate") and
 * to start video mid-GOP.
 */

import libavLoader from "./vendor/libav-6.10.9.0-tablo-mpeg2.mjs";
import glueUrl from "./vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs?url";
import wasmUrl from "./vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm?url";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

const DEVICE = "stream.ts";
const READ_LIMIT = 256 * 1024;

/**
 * How much the demuxer may read before it must name the streams.
 *
 * Bounded because the default is 5MB or EOF, which on a live feed is seconds
 * of black. This is a ceiling, not a target: measured against this device's
 * output with no end of stream to help it along, avformat names both streams
 * on well under one second of media — about a megabyte — and the ceiling is
 * never reached. It exists so that a stream which is *not* demuxable fails
 * promptly instead of reading for ever.
 */
const PROBE_BYTES = 2 * 1024 * 1024;
/** How much media it may analyse for stream parameters, in microseconds. */
const ANALYZE_MICROSECONDS = 2_000_000;

/**
 * How long the demuxer gets to name the streams once bytes start arriving.
 *
 * The failure this guards against was silent: fed a trickle, the reader device
 * blocks, `ff_init_demuxer_file` never returns, and the pipeline produces
 * nothing at all with no error to say why — indistinguishable, from the page,
 * from a decoder that is merely slow. Generous, because it is measured from
 * the first byte and one second of media is enough.
 */
const OPEN_DEADLINE_MS = 10_000;

/** AVFrame flags, from FFmpeg 9's `libavutil/frame.h`. */
const AV_FRAME_FLAG_INTERLACED = 1 << 3;
const AV_FRAME_FLAG_TOP_FIELD_FIRST = 1 << 4;

/** Stereo, as a channel layout mask: front left plus front right. */
const AV_CH_LAYOUT_STEREO = 3;

/** 1080i broadcast, used until the stream says otherwise. */
const DEFAULT_FRAME_DURATION = 1001 / 30000;

export interface DecodeOutput {
  video: DecodedVideoFrame[];
  audio: DecodedAudioChunk[];
}

/**
 * What the decoder can say about itself.
 *
 * Every number here exists because its absence cost a debugging session: with
 * no counters, a decoder producing nothing looks the same whether it was never
 * fed, never opened, opened on a stream with no video in it, or opened fine and
 * is merely behind.
 */
export interface DecoderStats {
  /** Bytes handed to `push`. */
  bytesFed: number;
  /** Bytes the demuxer has actually taken off the queue. */
  bytesDelivered: number;
  opened: boolean;
  /** What it took to name the streams, once it has. */
  bytesAtOpen: number | null;
  msToOpen: number | null;
  videoStream: boolean;
  audioStream: boolean;
  videoFrames: number;
  audioChunks: number;
}

export interface LibavDecoder {
  /** Feed bytes. Output arrives through `onOutput`, as it is decoded. */
  push(bytes: Uint8Array): Promise<void>;
  /** Signal end of input and wait for the pump to drain. */
  flush(): Promise<void>;
  /** Tear down and rebuild — for a seek or a stream discontinuity. */
  reset(): Promise<void>;
  close(): Promise<void>;
  stats(): DecoderStats;
}

export interface DecoderOptions {
  /**
   * Called as soon as each read round produces anything.
   *
   * Emitting rather than returning from `push` is the difference between
   * frames reaching the screen when they are decoded and reaching it when the
   * *next* segment happens to arrive — six seconds later, on this device.
   */
  onOutput?: (output: DecodeOutput) => void;
  /**
   * Where the wasm binary is.
   *
   * Bundled by default — Vite emits it as an asset and hands back its URL.
   * Node has no such URL, so the decode test passes a `file://` one.
   */
  wasmUrl?: string;
  /**
   * Where the emscripten runtime is.
   *
   * Same story as `wasmUrl`: bundled by default, and the decode test — which
   * runs in node, with no server to resolve a root-relative path against —
   * passes a `file://` one.
   */
  glueUrl?: string;
  /**
   * Deinterlace inside WASM with `bwdif`. Off, and measured: it costs about
   * nine tenths of the pipeline's budget. Kept so the comparison can be re-run
   * if libav.js ever gains SIMD.
   */
  deinterlace?: boolean;
  /** Override the open deadline. For tests, which cannot wait ten seconds. */
  openDeadlineMs?: number;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- libav.js ships no types
   for this build; this module is the boundary that gives it some. */
type Libav = any;
type LibavFrame = any;
type LibavStream = any;

/**
 * Resolve a bundled asset path against wherever this is running.
 *
 * Vite hands back a root-relative path, and libav.js imports it from its own
 * module scope rather than ours — where a bare "/assets/..." is fine but an
 * unresolved relative path is not. Left alone in node, which has no location.
 */
function absolute(url: string): string {
  const base = typeof self !== "undefined" ? self.location?.href : undefined;
  if (!base || /^[a-z]+:/i.test(url)) return url;
  return new URL(url, base).href;
}

function ptsSeconds(frame: LibavFrame): number {
  const base = frame.time_base_num / frame.time_base_den;
  const raw = (frame.ptshi ?? 0) * 4294967296 + (frame.pts ?? 0);
  return raw * base;
}

export async function createDecoder(options: DecoderOptions = {}): Promise<LibavDecoder> {
  const deinterlace = options.deinterlace ?? false;
  const emit = options.onOutput ?? (() => {});

  /**
   * The runtime is imported at load time, not bundled into this chunk.
   *
   * Handing libav.js a statically imported `factory` looks tidier and works
   * everywhere except the one place that matters. Bundled into the worker
   * chunk, the emscripten runtime loads and then wedges: it answers nothing,
   * never fetches its own wasm, and blocks its thread so completely that a
   * timer set beside it never fires — so there is no error to catch and no way
   * to tell, from the page, that anything happened at all. In dev, where Vite
   * serves the same modules separately, it opens in under half a second.
   *
   * Given `toImport` instead, libav.js imports the runtime itself at the URL
   * we name, which is how it expects to be loaded. `?url` makes Vite emit the
   * file as a plain asset rather than bundling it, exactly as for the wasm
   * binary beside it.
   *
   * `noworker`: this already runs inside our own worker, so libav.js should be
   * synchronous with it rather than starting a second one.
   */
  const openLibav = () => (libavLoader as Libav).LibAV({
    noworker: true,
    toImport: options.glueUrl ?? absolute(glueUrl),
    wasmurl: options.wasmUrl ?? absolute(wasmUrl),
  });

  /**
   * Loading the runtime, bounded.
   *
   * Emscripten reports a failure to instantiate by calling `abort()` from
   * inside a callback, which throws on a stack nobody is awaiting: the factory
   * promise is simply never settled. The result is a decoder that never
   * finishes being created, and above it a session that waits for frames from
   * a thing that does not exist yet — silently, until its deadline.
   */
  const loadLibav = async (): Promise<Libav> => {
    const limit = options.openDeadlineMs ?? OPEN_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(`libav runtime did not load within ${limit}ms`)),
        limit,
      );
    });
    try {
      return await Promise.race([openLibav(), expired]);
    } finally {
      clearTimeout(timer!);
    }
  };

  let libav: Libav = await loadLibav();

  let queue: Uint8Array[] = [];
  let atEof = false;
  /** True when libav asked for bytes we did not have; the next push answers it. */
  let starved = false;
  let pump: Promise<void> | null = null;
  let pumpError: unknown = null;

  let videoStream: LibavStream = null;
  let audioStream: LibavStream = null;
  let fmtCtx = 0;
  let vctx = 0, vpkt = 0, vframe = 0;
  let actx = 0, apkt = 0, aframe = 0;
  let vsrc = 0, vsink = 0;
  let asrc = 0, asink = 0;
  let frameDuration = DEFAULT_FRAME_DURATION;
  let lastVideoPts: number | null = null;
  /** First decoded audio timestamp, and samples emitted since. */
  let audioAnchorPts: number | null = null;
  let audioFramesEmitted = 0;

  let bytesFed = 0;
  let bytesDelivered = 0;
  let opened = false;
  let bytesAtOpen: number | null = null;
  let msToOpen: number | null = null;
  let firstByteAtMs: number | null = null;
  let videoFrames = 0;
  let audioChunks = 0;

  const feed = () => {
    if (queue.length) {
      const chunk = queue.shift()!;
      bytesDelivered += chunk.length;
      libav.ff_reader_dev_send(DEVICE, chunk);
      return;
    }
    if (atEof) {
      libav.ff_reader_dev_send(DEVICE, null);
      return;
    }
    // Leave the read outstanding. The next push resolves it.
    starved = true;
  };

  const wake = () => {
    if (!starved) return;
    starved = false;
    feed();
  };

  /** Rejects if the demuxer has not named the streams in time. */
  const openDeadline = (): Promise<never> => {
    const limit = options.openDeadlineMs ?? OPEN_DEADLINE_MS;
    return new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(
          `demuxer did not open within ${limit}ms` +
          ` (fed ${bytesFed} bytes, delivered ${bytesDelivered})`,
        ));
      }, limit);
      // Node keeps the process alive for a pending timer; the browser does not
      // care either way. Either way this must not outlive the decode.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
  };

  const open = async () => {
    await libav.mkreaderdev(DEVICE);
    libav.onread = feed;

    // Bound the probe. Left at its defaults, avformat reads 5MB — or waits for
    // EOF — before it will say what the streams are, which on a live feed is
    // seconds of silence before the first frame, and on a short fixture is
    // forever. A fifth of a second of TS is plenty to find two PIDs.
    let opts = 0;
    opts = await libav.av_dict_set_js(opts, "probesize", String(PROBE_BYTES), 0);
    opts = await libav.av_dict_set_js(opts, "analyzeduration", String(ANALYZE_MICROSECONDS), 0);

    // Raced against a deadline. The reader device blocks until it is given
    // data, so a feed too thin to demux leaves this call outstanding for ever
    // — and an open that never returns is invisible from the page: no frames,
    // no audio, no error, just a session that times out with nothing to say.
    const [ctx, streams] = await Promise.race([
      libav.ff_init_demuxer_file(DEVICE, { format: "mpegts", open_input_options: opts }),
      openDeadline(),
    ]);
    fmtCtx = ctx;
    opened = true;
    bytesAtOpen = bytesDelivered;
    msToOpen = firstByteAtMs === null ? null : Date.now() - firstByteAtMs;

    videoStream = streams.find((s: LibavStream) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
    audioStream = streams.find((s: LibavStream) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

    // Without this the pump reads packets for ever and emits nothing: no
    // decoder is built, so no frame can ever come out, and nothing says so.
    // A stream that names no video is not something to wait through — it is
    // the wrong stream, or a tuner that has not locked, and either way the
    // fallback should hear about it now rather than in eight seconds' time.
    if (!videoStream) {
      throw new Error(
        `no video stream after ${bytesDelivered} bytes` +
        ` (streams: ${streams.length}, audio: ${audioStream ? "yes" : "no"})`,
      );
    }

    if (videoStream) {
      [, vctx, vpkt, vframe] = await libav.ff_init_decoder(videoStream.codec_id, {
        codecpar: videoStream.codecpar,
        time_base: [videoStream.time_base_num, videoStream.time_base_den],
      });

      const num = await libav.AVCodecParameters_framerate_num(videoStream.codecpar);
      const den = await libav.AVCodecParameters_framerate_den(videoStream.codecpar);
      if (num > 0 && den > 0) frameDuration = den / num;

      if (deinterlace) {
        [, vsrc, vsink] = await libav.ff_init_filter_graph(
          "bwdif=mode=send_field:parity=auto:deint=all,format=pix_fmts=yuv420p",
          {
            type: libav.AVMEDIA_TYPE_VIDEO,
            width: 1920, height: 1080,
            pix_fmt: libav.AV_PIX_FMT_YUV420P,
            time_base: [videoStream.time_base_num, videoStream.time_base_den],
          },
          { type: libav.AVMEDIA_TYPE_VIDEO, pix_fmt: libav.AV_PIX_FMT_YUV420P },
        );
      }
    }

    if (audioStream) {
      [, actx, apkt, aframe] = await libav.ff_init_decoder(audioStream.codec_id, {
        codecpar: audioStream.codecpar,
        time_base: [audioStream.time_base_num, audioStream.time_base_den],
      });
    }
  };

  /**
   * Build the downmix from the first frame that arrives rather than from
   * constants: this device sends 5.1(side), and a graph declared as 5.1(back)
   * is refused outright ("changing audio frame properties on the fly").
   */
  const openAudioGraph = async (frame: LibavFrame) => {
    [, asrc, asink] = await libav.ff_init_filter_graph(
      "aresample,aformat=sample_fmts=flt:channel_layouts=stereo",
      {
        type: libav.AVMEDIA_TYPE_AUDIO,
        sample_rate: frame.sample_rate,
        sample_fmt: frame.format,
        channel_layout: frame.channel_layoutmask ?? frame.channel_layout,
      },
      {
        type: libav.AVMEDIA_TYPE_AUDIO,
        sample_rate: frame.sample_rate,
        sample_fmt: libav.AV_SAMPLE_FMT_FLT,
        channel_layout: AV_CH_LAYOUT_STEREO,
      },
    );
  };

  const toVideoFrame = (frame: LibavFrame): DecodedVideoFrame => {
    const pts = ptsSeconds(frame);
    // The stream's nominal frame rate gives the duration; the gap to the
    // previous frame corrects it when a stream drops or repeats.
    const measured = lastVideoPts === null ? frameDuration : pts - lastVideoPts;
    lastVideoPts = pts;
    return {
      data: frame.data,
      width: frame.width,
      height: frame.height,
      ptsSeconds: pts,
      durationSeconds: measured > 0 && measured < 1 ? measured : frameDuration,
      interlaced: Boolean(frame.flags & AV_FRAME_FLAG_INTERLACED),
      topFieldFirst: Boolean(frame.flags & AV_FRAME_FLAG_TOP_FIELD_FIRST),
    };
  };

  const runPump = async () => {
    await open();

    for (;;) {
      const [result, packets] = await libav.ff_read_frame_multi(fmtCtx, vpkt, {
        limit: READ_LIMIT,
      });
      const out: DecodeOutput = { video: [], audio: [] };

      const videoPackets = videoStream ? packets[videoStream.index] ?? [] : [];
      if (videoPackets.length) {
        const fin = result === libav.AVERROR_EOF;
        const frames = deinterlace
          ? await libav.ff_decode_filter_multi(vctx, vsrc, vsink, vpkt, vframe, videoPackets, {
              copyoutFrame: "video_packed", fin,
            })
          : await libav.ff_decode_multi(vctx, vpkt, vframe, videoPackets, {
              copyoutFrame: "video_packed", fin,
            });
        for (const frame of frames) out.video.push(toVideoFrame(frame));
      }

      const audioPackets = audioStream ? packets[audioStream.index] ?? [] : [];
      if (audioPackets.length) {
        const fin = result === libav.AVERROR_EOF;
        const decoded = await libav.ff_decode_multi(actx, apkt, aframe, audioPackets, { fin });
        if (decoded.length) {
          if (!asink) await openAudioGraph(decoded[0]);
          // Anchored on the decoder's own timestamps, before the graph.
          // buffersink re-bases what it emits onto the filter's timeline, and
          // that timeline is not the stream's: on a live feed it reported
          // audio at 30.6s while video from the same instant read 69.6s, which
          // is a 39-second lip-sync error dressed up as a starving decoder.
          if (audioAnchorPts === null) {
            audioAnchorPts = ptsSeconds(decoded[0]);
            audioFramesEmitted = 0;
          }

          const filtered = await libav.ff_filter_multi(asrc, asink, aframe, decoded, { fin });
          for (const frame of filtered) {
            const rate = frame.sample_rate ?? 48000;
            const frames = frame.data.length / 2;   // interleaved stereo
            out.audio.push({
              samples: frame.data,
              sampleRate: rate,
              ptsSeconds: audioAnchorPts + audioFramesEmitted / rate,
            });
            audioFramesEmitted += frames;
          }
        }
      }

      // Emitted here, the moment they exist. Holding them for the next `push`
      // would delay every frame until the following segment arrived.
      if (out.video.length || out.audio.length) {
        videoFrames += out.video.length;
        audioChunks += out.audio.length;
        emit(out);
      }

      if (result === libav.AVERROR_EOF) return;
      // -EAGAIN only means the output limit was reached; go round again.
      if (result !== 0 && result !== -libav.EAGAIN) {
        throw new Error(`libav read failed: ${result}`);
      }
    }
  };

  const start = () => {
    if (pump) return;
    pump = runPump().catch((e) => { pumpError = e; });
  };

  /** Let the pump make progress, and surface anything it threw. */
  const settle = async (): Promise<void> => {
    // A macrotask, not a microtask: the pump awaits libav calls that resolve on
    // the task queue, and a microtask would return before any of them ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (pumpError) throw pumpError instanceof Error ? pumpError : new Error(String(pumpError));
  };

  const teardown = async () => {
    atEof = true;
    wake();
    if (pump) await pump.catch(() => {});
    pump = null;
    try {
      if (videoStream) await libav.ff_free_decoder(vctx, vpkt, vframe);
      if (audioStream) await libav.ff_free_decoder(actx, apkt, aframe);
      if (fmtCtx) await libav.avformat_close_input_js(fmtCtx);
    } catch {
      // Freeing a half-built graph may fail; the instance goes away next
      // regardless, which frees everything with it.
    }
    libav.terminate?.();
    fmtCtx = 0;
    videoStream = null;
    audioStream = null;
    vctx = vpkt = vframe = 0;
    actx = apkt = aframe = 0;
    vsrc = vsink = 0;
    asrc = asink = 0;
    lastVideoPts = null;
    audioAnchorPts = null;
    audioFramesEmitted = 0;
    opened = false;
    bytesAtOpen = null;
    msToOpen = null;
    firstByteAtMs = null;
  };

  return {
    async push(bytes: Uint8Array) {
      if (firstByteAtMs === null) firstByteAtMs = Date.now();
      bytesFed += bytes.length;
      queue.push(bytes);
      start();
      wake();
      return settle();
    },

    stats: () => ({
      bytesFed,
      bytesDelivered,
      opened,
      bytesAtOpen,
      msToOpen,
      videoStream: Boolean(videoStream),
      audioStream: Boolean(audioStream),
      videoFrames,
      audioChunks,
    }),

    async flush() {
      atEof = true;
      start();
      wake();
      if (pump) await pump.catch((e) => { pumpError = e; });
      return settle();
    },

    async reset() {
      await teardown();
      queue = [];
      atEof = false;
      starved = false;
      pumpError = null;
      frameDuration = DEFAULT_FRAME_DURATION;
      libav = await loadLibav();
    },

    close: teardown,
  };
}
