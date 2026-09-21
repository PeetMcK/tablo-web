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

import { createTimeline, noteDecoded, noteEmitted, nextOutputPts } from "./audioTimeline";
import libavLoader from "./vendor/libav-6.10.9.0-tablo-mpeg2.mjs";
import glueUrl from "./vendor/libav-6.10.9.0-tablo-mpeg2.wasm.mjs?url";
import wasmUrl from "./vendor/libav-6.10.9.0-tablo-mpeg2.wasm.wasm?url";
import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

const DEVICE = "stream.ts";
const READ_LIMIT = 256 * 1024;

/**
 * How many read-rounds of unbroken audio-decode failure to tolerate before
 * giving up the session.
 *
 * A damaged audio frame — an AC-3 "new bit allocation info must be present in
 * block 0", routine in an OTA recording — makes libav's send_packet refuse the
 * packet. One such refusal used to throw out of the pump and kill everything,
 * video included, even though the video decoder conceals its own damage. So a
 * refused batch is dropped and decoding continues; audio resyncs at the next
 * good frame. Only failures that do not stop — a genuinely broken stream —
 * cross this count and end the session as before.
 */
const AUDIO_DECODE_FAIL_LIMIT = 20;

/**
 * The same tolerance for video, and for the same reason.
 *
 * Damage in the video elementary stream is as routine in an OTA recording as
 * damage in the audio: `mpeg2video` reports `ac-tex damaged` or `slice below
 * image`, conceals what it can, and then refuses one packet outright with
 * AVERROR_INVALIDDATA. ffmpeg's own CLI skips that packet and decodes the rest
 * of the segment; this threw out of the pump instead and ended the session —
 * picture, sound and all — on one bad frame. Recording 94912 died 17s in on
 * exactly that, twice over, because a rebuild resumes at the same playhead and
 * feeds the same bytes.
 *
 * So a refused batch is dropped and decoding continues; the decoder resyncs at
 * the next key frame. The cost is the few frames of that read round, which is
 * a blink against losing the stream.
 */
const VIDEO_DECODE_FAIL_LIMIT = 20;

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
  /**
   * Read rounds whose decode was refused and dropped, by stream.
   *
   * The tolerance above keeps a damaged recording playing, and does it
   * silently: the pump swallows the refusal and carries on. Without these, a
   * session that lost media reads exactly like one that lost none, and the
   * cost of surviving is invisible at the moment it is paid. See
   * VIDEO_DECODE_FAIL_LIMIT.
   */
  videoDropped: number;
  audioDropped: number;
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
  /**
   * Called when the read pump dies, at the moment it dies.
   *
   * Without it a pump failure waits for the next `push` to be reported, and
   * the transport does not always make one: pacing holds segments back when
   * the field queue is full or the viewer has paused. The failure then
   * surfaced six seconds later as the frozen-picture watchdog's "nothing drawn
   * for 6s" — the right session ended for the wrong stated reason, with the
   * actual error still sitting in a variable.
   */
  onError?: (error: Error) => void;
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

/**
 * Sample frames in a decoded audio frame, however libav.js chose to hand it over.
 *
 * `nb_samples` is the answer when it is there. When it is not, the shape of
 * `data` says: planar formats — which AC-3 decodes to — give one array per
 * channel, so the first plane's length is the frame count; a packed format
 * gives one interleaved array, which has to be divided by the channel count.
 */
function sampleFramesOf(frame: LibavFrame): number {
  if (typeof frame.nb_samples === "number") return frame.nb_samples;
  const data = frame.data;
  if (Array.isArray(data)) return data[0]?.length ?? 0;
  const channels = frame.channels ?? 2;
  return data.length / Math.max(1, channels);
}

/**
 * The frame's pixel shape as a single ratio, or 1 when it does not say.
 *
 * MPEG-2 carries a sample aspect that is frequently not square. This device's
 * SD subchannels arrive 720x480 with 32:27 pixels - a 16:9 picture in a frame
 * whose coded shape is 1.5 - so a renderer that assumes square pixels draws it
 * 16% too narrow. Measured against the same broadcast on an iPhone, which gets
 * it right.
 */
function sampleAspectOf(frame: LibavFrame): number {
  const num = frame.sample_aspect_ratio_num ?? frame.sample_aspect_ratio?.[0];
  const den = frame.sample_aspect_ratio_den ?? frame.sample_aspect_ratio?.[1];
  if (typeof num !== "number" || typeof den !== "number" || num <= 0 || den <= 0) {
    return 1;
  }
  return num / den;
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

  let bytesFed = 0;
  let bytesDelivered = 0;
  let opened = false;
  let bytesAtOpen: number | null = null;
  let msToOpen: number | null = null;
  let firstByteAtMs: number | null = null;
  let videoFrames = 0;
  let audioChunks = 0;
  // Cumulative, like the frame counts above: `reset` rebuilds the decoder for
  // a seek but does not rewrite what this session has already been through.
  let videoDropped = 0;
  let audioDropped = 0;

  /**
   * Bound a call that may never return, and clean up either way.
   *
   * The reader device blocks until it is given data, so a feed too thin to
   * demux leaves `ff_init_demuxer_file` outstanding for ever — and an open
   * that never returns is invisible from the page: no frames, no audio, no
   * error, just a session that times out with nothing to say.
   *
   * The `finally` is the part that was missing. When the open won its race the
   * timer was left to fire ten seconds later against a promise nobody was
   * holding: one dangling timer and one unhandled rejection per open, and an
   * open happens on every seek.
   */
  const withDeadline = async <T>(work: Promise<T>, failure: string): Promise<T> => {
    const limit = options.openDeadlineMs ?? OPEN_DEADLINE_MS;
    let timer: ReturnType<typeof setTimeout>;
    const expired = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new Error(
          `${failure} within ${limit}ms` +
          ` (fed ${bytesFed} bytes, delivered ${bytesDelivered})`,
        )),
        limit,
      );
      // Node keeps the process alive for a pending timer; the browser does not
      // care either way. Either way this must not outlive the decode.
      (timer as unknown as { unref?: () => void }).unref?.();
    });
    // If the deadline wins, `work` is still outstanding and may reject later
    // against nobody. Claimed here so that is not an unhandled rejection.
    work.catch(() => {});
    try {
      return await Promise.race([work, expired]);
    } finally {
      clearTimeout(timer!);
    }
  };

  /**
   * Loading the runtime, bounded.
   *
   * Emscripten reports a failure to instantiate by calling `abort()` from
   * inside a callback, which throws on a stack nobody is awaiting: the factory
   * promise is simply never settled. The result is a decoder that never
   * finishes being created, and above it a session that waits for frames from
   * a thing that does not exist yet — silently, until its deadline.
   */
  const loadLibav = (): Promise<Libav> => withDeadline(openLibav(), "libav runtime did not load");

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
  // The graph handles are kept, not discarded. `libav.terminate()` is a no-op
  // in `noworker` mode in this vendored build, so nothing else ever frees
  // them, and a graph is rebuilt on every seek.
  let vgraph = 0, vsrc = 0, vsink = 0;
  let agraph = 0, asrc = 0, asink = 0;
  let frameDuration = DEFAULT_FRAME_DURATION;
  let lastVideoPts: number | null = null;
  /** The output timeline, corrected from the decoder's own timestamps. */
  let audioTimeline = createTimeline();

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

    const [ctx, streams] = await withDeadline<[number, LibavStream[]]>(
      libav.ff_init_demuxer_file(DEVICE, { format: "mpegts", open_input_options: opts }),
      "demuxer did not open",
    );
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
        [vgraph, vsrc, vsink] = await libav.ff_init_filter_graph(
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
    [agraph, asrc, asink] = await libav.ff_init_filter_graph(
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
      sampleAspectRatio: sampleAspectOf(frame),
    };
  };

  const runPump = async () => {
    await open();

    // Consecutive read-rounds whose audio decode threw; reset on any clean
    // audio decode. See AUDIO_DECODE_FAIL_LIMIT.
    let audioFailStreak = 0;
    // The same for video. See VIDEO_DECODE_FAIL_LIMIT.
    let videoFailStreak = 0;

    for (;;) {
      const [result, packets] = await libav.ff_read_frame_multi(fmtCtx, vpkt, {
        limit: READ_LIMIT,
      });
      const out: DecodeOutput = { video: [], audio: [] };

      const videoPackets = videoStream ? packets[videoStream.index] ?? [] : [];
      if (videoPackets.length) {
        const fin = result === libav.AVERROR_EOF;
        let frames: LibavFrame[];
        try {
          frames = deinterlace
            ? await libav.ff_decode_filter_multi(vctx, vsrc, vsink, vpkt, vframe, videoPackets, {
                copyoutFrame: "video_packed", fin,
              })
            : await libav.ff_decode_multi(vctx, vpkt, vframe, videoPackets, {
                copyoutFrame: "video_packed", fin,
              });
          videoFailStreak = 0;
        } catch (e) {
          // A refused video packet (a damaged MPEG-2 frame) is survivable:
          // drop this batch and keep decoding what follows. Give up only if
          // the failures do not stop.
          videoFailStreak += 1;
          if (videoFailStreak > VIDEO_DECODE_FAIL_LIMIT) throw e;
          videoDropped += 1;
          frames = [];
        }
        for (const frame of frames) out.video.push(toVideoFrame(frame));
        // Correct each duration from the frame that follows it.
        //
        // `toVideoFrame` measures the gap to the *previous* frame, which is
        // all it can see; ffplay's `vp_duration` uses the next one, and the
        // difference shows at a cadence change - the second field of an
        // interlaced frame is placed at pts + duration/2, so a duration
        // borrowed from the wrong side mistimes it by half the error. The last
        // frame of a read round keeps its backward estimate, because there is
        // nothing after it yet.
        for (let i = 0; i + 1 < out.video.length; i++) {
          const gap = out.video[i + 1].ptsSeconds - out.video[i].ptsSeconds;
          if (gap > 0 && gap < 1) out.video[i].durationSeconds = gap;
        }
      }

      const audioPackets = audioStream ? packets[audioStream.index] ?? [] : [];
      if (audioPackets.length) {
        const fin = result === libav.AVERROR_EOF;
        let decoded: LibavFrame[];
        try {
          decoded = await libav.ff_decode_multi(actx, apkt, aframe, audioPackets, { fin });
          audioFailStreak = 0;
        } catch (e) {
          // A refused audio packet (damaged AC-3 frame) is survivable: drop
          // this batch and keep decoding video and the audio that follows.
          // Give up only if the failures do not stop.
          audioFailStreak += 1;
          if (audioFailStreak > AUDIO_DECODE_FAIL_LIMIT) throw e;
          audioDropped += 1;
          decoded = [];
        }
        if (decoded.length) {
          if (!asink) await openAudioGraph(decoded[0]);
          // Accounted before the graph, where the timestamps mean something.
          // buffersink re-bases what it emits onto the filter's timeline, and
          // that timeline is not the stream's: on a live feed it reported
          // audio at 30.6s while video from the same instant read 69.6s, which
          // is a 39-second lip-sync error dressed up as a starving decoder.
          //
          // So the output timeline counts samples and takes its corrections
          // from here: a frame that lands where it was not expected is a drop
          // or a discontinuity, and either way the media really is somewhere
          // other than the sample count believes.
          for (const frame of decoded) {
            noteDecoded(
              audioTimeline,
              ptsSeconds(frame),
              sampleFramesOf(frame),
              frame.sample_rate ?? 48000,
            );
          }

          const filtered = await libav.ff_filter_multi(asrc, asink, aframe, decoded, { fin });
          for (const frame of filtered) {
            const rate = frame.sample_rate ?? 48000;
            const frames = frame.data.length / 2;   // interleaved stereo
            out.audio.push({
              samples: frame.data,
              sampleRate: rate,
              ptsSeconds: nextOutputPts(audioTimeline, rate),
            });
            noteEmitted(audioTimeline, frames);
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
    pump = runPump().catch((e) => {
      pumpError = e;
      // Reported now, not on the next push. Tearing down is a normal way for
      // the pump to end, so the caller is told only about failures that are
      // not our own teardown.
      if (!atEof) options.onError?.(e instanceof Error ? e : new Error(String(e)));
    });
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
      if (vgraph) await libav.avfilter_graph_free_js(vgraph);
      if (agraph) await libav.avfilter_graph_free_js(agraph);
      if (fmtCtx) await libav.avformat_close_input_js(fmtCtx);
    } catch {
      // Freeing a half-built graph may fail; the instance goes away next
      // regardless, which frees everything with it.
    }
    // `terminate` is defined but empty in `noworker` mode, which is the mode
    // this runs in. It is called anyway because the same code path is used
    // under a real libav.js worker, where it does free the instance - but the
    // frees above are what actually matter here.
    libav.terminate?.();
    fmtCtx = 0;
    videoStream = null;
    audioStream = null;
    vctx = vpkt = vframe = 0;
    actx = apkt = aframe = 0;
    vgraph = vsrc = vsink = 0;
    agraph = asrc = asink = 0;
    lastVideoPts = null;
    audioTimeline = createTimeline();
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
      videoDropped,
      audioDropped,
    }),

    async flush() {
      atEof = true;
      start();
      wake();
      if (pump) await pump.catch((e) => { pumpError = e; });
      return settle();
    },

    async reset() {
      // Emptied before the teardown, not after. `teardown` signals EOF and
      // waits for the pump to drain, and the pump decodes whatever is still
      // queued on its way out — so a seek spent up to a lookahead's worth of
      // decode on media it was about to throw away, while the viewer waited
      // for the new position.
      queue = [];
      await teardown();
      atEof = false;
      starved = false;
      pumpError = null;
      frameDuration = DEFAULT_FRAME_DURATION;
      libav = await loadLibav();
    },

    close: teardown,
  };
}
