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

import type { DecodedAudioChunk, DecodedVideoFrame } from "./types";

const VARIANT_URL = "/wasm/libav/libav-6.10.9.0-tablo-mpeg2.mjs";
const DEVICE = "stream.ts";
const READ_LIMIT = 256 * 1024;

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

export interface LibavDecoder {
  /** Feed bytes; returns whatever has finished decoding so far. */
  push(bytes: Uint8Array): Promise<DecodeOutput>;
  /** Signal end of input, wait for the pump, and return the remainder. */
  flush(): Promise<DecodeOutput>;
  /** Tear down and rebuild — for a seek or a stream discontinuity. */
  reset(): Promise<void>;
  close(): Promise<void>;
}

export interface DecoderOptions {
  /** Where the libav.js loader lives. */
  url?: string;
  /**
   * Deinterlace inside WASM with `bwdif`. Off, and measured: it costs about
   * nine tenths of the pipeline's budget. Kept so the comparison can be re-run
   * if libav.js ever gains SIMD.
   */
  deinterlace?: boolean;
}

/* eslint-disable @typescript-eslint/no-explicit-any -- libav.js ships no types
   for this build; this module is the boundary that gives it some. */
type Libav = any;
type LibavFrame = any;
type LibavStream = any;

function ptsSeconds(frame: LibavFrame): number {
  const base = frame.time_base_num / frame.time_base_den;
  const raw = (frame.ptshi ?? 0) * 4294967296 + (frame.pts ?? 0);
  return raw * base;
}

export async function createDecoder(options: DecoderOptions = {}): Promise<LibavDecoder> {
  const url = options.url ?? VARIANT_URL;
  const deinterlace = options.deinterlace ?? false;
  const factory = await import(/* @vite-ignore */ url);

  // `noworker`: this already runs inside our own worker, so libav.js should be
  // synchronous with it rather than starting a second one.
  let libav: Libav = await factory.LibAV({ noworker: true });

  let queue: Uint8Array[] = [];
  let atEof = false;
  /** True when libav asked for bytes we did not have; the next push answers it. */
  let starved = false;
  let pump: Promise<void> | null = null;
  let pumpError: unknown = null;

  let outVideo: DecodedVideoFrame[] = [];
  let outAudio: DecodedAudioChunk[] = [];

  let videoStream: LibavStream = null;
  let audioStream: LibavStream = null;
  let fmtCtx = 0;
  let vctx = 0, vpkt = 0, vframe = 0;
  let actx = 0, apkt = 0, aframe = 0;
  let vsrc = 0, vsink = 0;
  let asrc = 0, asink = 0;
  let frameDuration = DEFAULT_FRAME_DURATION;
  let lastVideoPts: number | null = null;

  const feed = () => {
    if (queue.length) {
      libav.ff_reader_dev_send(DEVICE, queue.shift());
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

    const [ctx, streams] = await libav.ff_init_demuxer_file(DEVICE);
    fmtCtx = ctx;
    videoStream = streams.find((s: LibavStream) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO) ?? null;
    audioStream = streams.find((s: LibavStream) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO) ?? null;

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
        for (const frame of frames) outVideo.push(toVideoFrame(frame));
      }

      const audioPackets = audioStream ? packets[audioStream.index] ?? [] : [];
      if (audioPackets.length) {
        const fin = result === libav.AVERROR_EOF;
        const decoded = await libav.ff_decode_multi(actx, apkt, aframe, audioPackets, { fin });
        if (decoded.length) {
          if (!asink) await openAudioGraph(decoded[0]);
          const filtered = await libav.ff_filter_multi(asrc, asink, aframe, decoded, { fin });
          for (const frame of filtered) {
            outAudio.push({
              samples: frame.data,
              sampleRate: frame.sample_rate,
              ptsSeconds: ptsSeconds(frame),
            });
          }
        }
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

  /** Let the pump make progress, then hand back whatever it produced. */
  const collect = async (): Promise<DecodeOutput> => {
    // A macrotask, not a microtask: the pump awaits libav calls that resolve on
    // the task queue, and a microtask would return before any of them ran.
    await new Promise((resolve) => setTimeout(resolve, 0));
    if (pumpError) throw pumpError instanceof Error ? pumpError : new Error(String(pumpError));
    const out = { video: outVideo, audio: outAudio };
    outVideo = [];
    outAudio = [];
    return out;
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
  };

  return {
    async push(bytes: Uint8Array) {
      queue.push(bytes);
      start();
      wake();
      return collect();
    },

    async flush() {
      atEof = true;
      start();
      wake();
      if (pump) await pump.catch((e) => { pumpError = e; });
      return collect();
    },

    async reset() {
      await teardown();
      queue = [];
      outVideo = [];
      outAudio = [];
      atEof = false;
      starved = false;
      pumpError = null;
      frameDuration = DEFAULT_FRAME_DURATION;
      libav = await factory.LibAV({ noworker: true });
    },

    close: teardown,
  };
}
