/**
 * Cues, held on the session and asked for in media time.
 *
 * The conversion is the whole subject. The decoder counts in the device's PTS,
 * which starts wherever the broadcast happened to be; the player counts in
 * media seconds. Everything else the session does already crosses that gap, so
 * a caption that did not would be off by however long the channel had been on
 * air — hours, not milliseconds.
 */

import { describe, it, expect, vi } from "vitest";

import { createSession } from "../lib/wasmlive/session";
import type { SessionDeps } from "../lib/wasmlive/session";
import type { CaptionCue } from "../lib/captions";

const ORIGIN = Date.parse("2026-09-16T20:00:00Z");

/** A ring window whose live edge is 36 seconds in. */
const PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:5
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:30+00:00
#EXTINF:6.000,
00005.ts
#EXTINF:6.000,
00006.ts
`;

function harness(overrides: Partial<SessionDeps> = {}) {
  let clockSeconds: number | null = null;

  const worker = {
    postMessage: () => {},
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    onmessageerror: null as ((e: Event) => void) | null,
  };

  const audio = {
    push: vi.fn(),
    get clockSeconds() { return clockSeconds; },
    get bufferedSeconds() { return 0; },
    get contextState() { return "running" as AudioContextState; },
    starvedBy: vi.fn(() => 0),
    setMuted: vi.fn(),
    muted: false,
    setVolume: vi.fn(),
    volume: 1,
    flush: vi.fn(),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    diagnostics: () => ({ audioContext: "running" }),
  };

  const presenter = {
    offer: vi.fn(), tick: vi.fn(),
    newestPts: null as number | null, oldestPts: null as number | null,
    presentedCount: 0, droppedCount: 0, skippedCount: 0, tickCount: 0,
    msSinceTick: 0, nothingDueMs: 0, queued: 0,
    destroy: vi.fn(),
  };

  const session = createSession({
    playlistUrl: "/api/raw/abc/playlist.m3u8",
    originMs: ORIGIN,
    worker: worker as unknown as Worker,
    audio,
    presenter,
    fetchText: async () => PLAYLIST,
    fetchBytes: async () => new ArrayBuffer(8),
    nowMs: () => 0,
    schedule: () => () => {},
    ...overrides,
  });

  const send = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);

  return {
    session,
    send,
    setClock: (t: number | null) => { clockSeconds = t; },
    /**
     * Anchor the clock, which is what fixes the offset between the device's
     * PTS and media time. The live edge of the window above is 36s in, so a
     * chunk at PTS `pts` makes media time `raw + (36 - pts)`.
     */
    anchor: (pts: number) => send({
      type: "audio", epoch: 0,
      chunks: [{ ptsSeconds: pts, samples: new Float32Array(2), sampleRate: 48000 }],
    }),
    captions: (cues: CaptionCue[], epoch = 0) => send({ type: "captions", epoch, cues }),
  };
}

const HELLO: CaptionCue = { startSeconds: 36, endSeconds: 39, text: "HELLO" };

describe("the session's captions", () => {
  it("is unavailable until a cue arrives", async () => {
    const h = harness();
    await h.session.start();

    expect(h.session.captions.available).toBe(false);
    expect(h.session.captions.at(0)).toBeNull();
  });

  it("offers the cue covering the given media time", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);          // PTS 36 at the live edge: media time and PTS agree
    h.captions([HELLO]);

    expect(h.session.captions.available).toBe(true);
    expect(h.session.captions.at(37)?.text).toBe("HELLO");
    expect(h.session.captions.at(35)).toBeNull();
    expect(h.session.captions.at(40)).toBeNull();
  });

  it("reads cues in media time, not the decoder's", async () => {
    const h = harness();
    await h.session.start();
    // The device's clock starts wherever it starts. PTS 9000 at a live edge of
    // 36s puts media time 8964 seconds behind the numbers the cues carry.
    h.anchor(9000);
    h.captions([{ startSeconds: 9000, endSeconds: 9003, text: "HELLO" }]);

    expect(h.session.captions.at(37)?.text).toBe("HELLO");
    expect(h.session.captions.at(9001)).toBeNull();
  });

  it("discards cues from before a seek", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.captions([{ startSeconds: 36, endSeconds: 39, text: "STALE" }], 99);

    expect(h.session.captions.at(37)).toBeNull();
  });

  it("replaces a cue the parser revised rather than showing it twice", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.captions([{ startSeconds: 36, endSeconds: 37, text: "HEL" }]);
    h.captions([{ startSeconds: 36, endSeconds: 39, text: "HELLO" }]);

    expect(h.session.captions.at(38)?.text).toBe("HELLO");
  });

  it("tells a listener when cues change", async () => {
    const h = harness();
    await h.session.start();
    let changes = 0;
    h.session.captions.on("change", () => { changes++; });
    h.captions([HELLO]);

    expect(changes).toBe(1);
  });

  it("forgets cues on a seek but stays a captioned stream", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.captions([HELLO]);

    h.session.seek(31);
    await h.session.poll();

    expect(h.session.captions.at(37)).toBeNull();
    // The channel is still captioned; only the position changed.
    expect(h.session.captions.available).toBe(true);
  });
});
