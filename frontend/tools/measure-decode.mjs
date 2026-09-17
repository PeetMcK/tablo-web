// Decodes a saved 1080i MPEG-2 sample end to end and prints the multiple of
// realtime achieved. This is the number the whole project is gated on: below
// 1.5x there is no headroom for presentation and audio, and the existing
// FFmpeg transcode wins on merit.
//
// Usage: node tools/measure-decode.mjs <sample.ts> [--no-deinterlace]
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// The .mjs loader, not the .js one: this package is `type: module`, so node
// parses the CommonJS build as ESM and its implicit LibAV global throws.
const LibAVFactory = await import("../public/wasm/libav/libav-6.10.9.0-tablo-mpeg2.mjs");

const path = process.argv[2];
const deinterlace = !process.argv.includes("--no-deinterlace");
// Copying a 1080p frame out of the wasm heap is 3.1 MB per frame; "--ptr"
// leaves frames inside libav so the cost of the copy can be measured apart
// from the cost of the decode.
const copyoutFrame = process.argv.includes("--ptr") ? "ptr" : "video_packed";
const skipAudio = process.argv.includes("--no-audio");
if (!path) {
  console.error("usage: node tools/measure-decode.mjs <sample.ts> [--no-deinterlace]");
  process.exit(2);
}

const bytes = new Uint8Array(readFileSync(path));
const CHUNK = 64 * 1024;
const DEVICE = "stream.ts";

const libav = await LibAVFactory.LibAV({ noworker: true });

await libav.mkreaderdev(DEVICE);
let sent = 0;
libav.onread = () => {
  if (sent >= bytes.length) {
    libav.ff_reader_dev_send(DEVICE, null);
    return;
  }
  const end = Math.min(sent + CHUNK, bytes.length);
  libav.ff_reader_dev_send(DEVICE, bytes.subarray(sent, end));
  sent = end;
};

const t0 = performance.now();

const [fmtCtx, streams] = await libav.ff_init_demuxer_file(DEVICE);
const video = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_VIDEO);
const audio = streams.find((s) => s.codec_type === libav.AVMEDIA_TYPE_AUDIO);
if (!video) throw new Error("no video stream found");

const [, vctx, vpkt, vframe] = await libav.ff_init_decoder(video.codec_id, {
  codecpar: video.codecpar,
  time_base: [video.time_base_num, video.time_base_den],
});

let asrcCtx = 0, apkt = 0, aframe = 0;
if (audio) {
  [, asrcCtx, apkt, aframe] = await libav.ff_init_decoder(audio.codec_id, {
    codecpar: audio.codecpar,
    time_base: [audio.time_base_num, audio.time_base_den],
  });
}

// The graph the browser will run: bwdif emitting one frame per field (60p from
// 1080i29.97), then a pin to yuv420p so the output is always I420.
const chosen = process.argv.find((a) => a.startsWith("--filter="))?.slice("--filter=".length);
const description = chosen
  ? `${chosen},format=pix_fmts=yuv420p`
  : deinterlace
    ? "bwdif=mode=send_field:parity=auto:deint=all,format=pix_fmts=yuv420p"
    : "format=pix_fmts=yuv420p";
const [, vsrc, vsink] = await libav.ff_init_filter_graph(
  description,
  {
    type: libav.AVMEDIA_TYPE_VIDEO,
    width: video.width ?? 1920,
    height: video.height ?? 1080,
    pix_fmt: libav.AV_PIX_FMT_YUV420P,
    time_base: [video.time_base_num, video.time_base_den],
  },
  { type: libav.AVMEDIA_TYPE_VIDEO, pix_fmt: libav.AV_PIX_FMT_YUV420P },
);

let frames = 0;
let audioFrames = 0;
// Media duration is taken from the *packet* timestamps, in the input stream's
// own timebase. Frame timestamps are not usable for this: bwdif=send_field
// halves the output timebase, so the same numbers mean half as much.
let firstPts = null;
let lastPts = null;
const videoBase = video.time_base_num / video.time_base_den;

for (;;) {
  const [result, packets] = await libav.ff_read_frame_multi(fmtCtx, vpkt, { limit: 256 * 1024 });

  const vp = packets[video.index] ?? [];
  if (vp.length) {
    for (const p of vp) {
      const pts = ((p.ptshi ?? 0) * 4294967296 + (p.pts ?? 0)) * videoBase;
      if (!Number.isFinite(pts)) continue;
      if (firstPts === null || pts < firstPts) firstPts = pts;
      if (lastPts === null || pts > lastPts) lastPts = pts;
    }
    const out = await libav.ff_decode_filter_multi(vctx, vsrc, vsink, vpkt, vframe, vp, {
      copyoutFrame,
      fin: result === libav.AVERROR_EOF,
    });
    frames += out.length;
  }

  if (audio && !skipAudio) {
    const ap = packets[audio.index] ?? [];
    if (ap.length) {
      const out = await libav.ff_decode_multi(asrcCtx, apkt, aframe, ap, {
        fin: result === libav.AVERROR_EOF,
      });
      audioFrames += out.length;
    }
  }

  if (result === libav.AVERROR_EOF) break;
  if (result !== 0 && result !== -libav.EAGAIN) throw new Error(`read failed: ${result}`);
}

const wallSeconds = (performance.now() - t0) / 1000;
const clipSeconds = firstPts !== null && lastPts !== null ? lastPts - firstPts : 0;

console.log(JSON.stringify({
  deinterlace,
  copyoutFrame,
  audioDecoded: Boolean(audio) && !skipAudio,
  videoFrames: frames,
  audioFrames,
  clipSeconds: +clipSeconds.toFixed(2),
  wallSeconds: +wallSeconds.toFixed(2),
  realtimeMultiple: +(clipSeconds / wallSeconds).toFixed(2),
  framesPerSecond: +(frames / wallSeconds).toFixed(1),
}, null, 2));
