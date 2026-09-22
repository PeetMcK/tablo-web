/**
 * Which decoder a viewer sees, and when that changes.
 *
 * The rule has one direction on purpose. 708 carries placement and is
 * preferred wherever it speaks; 608 is the floor, and the floor is what a
 * stream starts on. Falling back the other way, mid-programme, would resume a
 * decoder that has been running unwatched and produce a sentence belonging to
 * neither.
 */

import { describe, it, expect, vi } from "vitest";

import { createSession } from "../lib/wasmlive/session";
import type { SessionDeps } from "../lib/wasmlive/session";
import type { PositionedCue } from "../lib/captions";

const ORIGIN = Date.parse("2026-09-16T20:00:00Z");

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
    setMuted: vi.fn(), muted: false, setVolume: vi.fn(), volume: 1,
    flush: vi.fn(),
    resume: vi.fn(async () => {}), suspend: vi.fn(async () => {}),
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
    audio, presenter,
    fetchText: async () => PLAYLIST,
    fetchBytes: async () => new ArrayBuffer(8),
    nowMs: () => 0,
    schedule: () => () => {},
    ...overrides,
  });

  const send = (data: unknown) => worker.onmessage?.({ data } as MessageEvent);

  return {
    session,
    setClock: (t: number | null) => { clockSeconds = t; },
    /** Anchor the clock; the window's live edge is 36s in. */
    anchor: (pts: number) => send({
      type: "audio", epoch: 0,
      chunks: [{ ptsSeconds: pts, samples: new Float32Array(2), sampleRate: 48000 }],
    }),
    cues: (source: "cea608" | "cea708", cues: PositionedCue[], epoch = 0) =>
      send({ type: "captions", epoch, cues, source }),
  };
}

const AT_608: PositionedCue = { startSeconds: 36, endSeconds: 39, text: "from 608" };
const AT_708: PositionedCue = {
  startSeconds: 36, endSeconds: 39, text: "from 708",
  region: { anchor: "bottom-left", xPercent: 50, yPercent: 99, rows: 4, columns: 32 },
};

describe("choosing between 608 and 708", () => {
  it("shows 608 while 708 has said nothing", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea608", [AT_608]);

    expect(h.session.captions.at(37)?.text).toBe("from 608");
    expect(h.session.captions.available).toBe(true);
  });

  it("switches to 708 on its first cue", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea608", [AT_608]);
    h.cues("cea708", [AT_708]);

    expect(h.session.captions.at(37)?.text).toBe("from 708");
    // And with it, the placement that is the whole reason for the switch.
    expect(h.session.captions.at(37)?.region?.xPercent).toBe(50);
  });

  it("does not fall back when 708 goes quiet", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea708", [AT_708]);
    // 608 keeps running underneath and keeps producing, as it does in a real
    // stream. It must not take the screen back.
    h.cues("cea608", [{ startSeconds: 40, endSeconds: 44, text: "from 608" }]);

    expect(h.session.captions.at(42)).toBeNull();
  });

  it("keeps the latch across a seek", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea708", [AT_708]);

    h.session.seek(31);
    await h.session.poll();
    h.anchor(31);
    h.cues("cea608", [{ startSeconds: 31, endSeconds: 34, text: "from 608" }]);
    h.cues("cea708", [{ startSeconds: 31, endSeconds: 34, text: "still 708" }], 1);

    // The cue from the stale epoch is dropped; the latch is not.
    expect(h.session.captions.available).toBe(true);
    expect(h.session.captions.at(32)?.text).not.toBe("from 608");
  });

  it("offers a button for a broadcast that carries only 708", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea708", [AT_708]);

    expect(h.session.captions.available).toBe(true);
    expect(h.session.captions.at(37)?.text).toBe("from 708");
  });

  it("reports which standard is on screen", async () => {
    const h = harness();
    await h.session.start();
    h.anchor(36);
    h.cues("cea608", [AT_608]);
    expect(h.session.diagnostics().captionStandard).toBe("cea608");

    h.cues("cea708", [AT_708]);
    expect(h.session.diagnostics().captionStandard).toBe("cea708");
  });
});
