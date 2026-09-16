import { describe, it, expect, vi } from "vitest";

import { createSession } from "../lib/wasmlive/session";
import { createWasmSurface } from "../lib/wasmlive/wasmSurface";
import type { SessionDeps } from "../lib/wasmlive/session";

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

/** The window one segment further on, as the ring slides. */
const PLAYLIST_NEXT = `#EXTM3U
#EXT-X-TARGETDURATION:6
#EXT-X-MEDIA-SEQUENCE:6
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:36+00:00
#EXTINF:6.000,
00006.ts
#EXTINF:6.000,
00007.ts
`;

function harness(overrides: Partial<SessionDeps> = {}) {
  const posted: { type: string }[] = [];
  const fetched: string[] = [];
  let clockSeconds: number | null = 36;

  const worker = {
    postMessage: (m: { type: string }) => posted.push(m),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
  };

  const audio = {
    push: vi.fn(),
    get clockSeconds() { return clockSeconds; },
    starvedBy: vi.fn(() => 0),
    setMuted: vi.fn(),
    muted: false,
    flush: vi.fn(),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
  };

  const presenter = {
    offer: vi.fn(),
    tick: vi.fn(),
    newestPts: null as number | null,
    presentedCount: 0,
    queued: 0,
    destroy: vi.fn(),
  };

  let playlist = PLAYLIST;
  const session = createSession({
    playlistUrl: "/api/raw/abc/playlist.m3u8",
    originMs: ORIGIN,
    worker: worker as unknown as Worker,
    audio,
    presenter,
    fetchText: async (url: string) => { fetched.push(url); return playlist; },
    fetchBytes: async (url: string) => { fetched.push(url); return new ArrayBuffer(8); },
    nowMs: () => 0,
    schedule: () => () => {},
    ...overrides,
  });

  return {
    session, worker, posted, fetched, audio, presenter,
    slide: () => { playlist = PLAYLIST_NEXT; },
    setClock: (t: number | null) => { clockSeconds = t; },
  };
}

describe("createSession", () => {
  it("opens the worker before fetching anything", async () => {
    const { session, posted } = harness();
    await session.start();
    expect(posted[0].type).toBe("open");
  });

  it("reports the ring window as its seekable range", async () => {
    const { session } = harness();
    await session.start();
    expect(session.seekable).toEqual([30, 42]);
  });

  it("has no range before the first playlist lands", () => {
    const { session } = harness();
    expect(session.seekable).toBeNull();
  });

  it("takes its current time from the audio clock", async () => {
    const { session } = harness();
    await session.start();
    expect(session.currentTime).toBe(36);
  });

  it("fetches segments from the playlist's own directory", async () => {
    const { session, fetched } = harness();
    await session.start();
    expect(fetched).toContain("/api/raw/abc/00005.ts");
    expect(fetched).toContain("/api/raw/abc/00006.ts");
  });

  it("sends fetched segment bytes to the worker", async () => {
    const { session, posted } = harness();
    await session.start();
    expect(posted.filter((m) => m.type === "segment")).toHaveLength(2);
  });

  it("fetches each segment once as the window slides", async () => {
    const { session, fetched, slide } = harness();
    await session.start();
    slide();
    await session.poll();
    // 00006 was already taken; only 00007 is new.
    expect(fetched.filter((u) => u.endsWith("00006.ts"))).toHaveLength(1);
    expect(fetched.filter((u) => u.endsWith("00007.ts"))).toHaveLength(1);
  });

  it("hands decoded video to the presenter and audio to the sink", async () => {
    const { session, worker, presenter, audio } = harness();
    await session.start();
    const frame = { ptsSeconds: 30, data: new Uint8Array(6) };
    const chunk = { ptsSeconds: 30, samples: new Float32Array(2), sampleRate: 48000 };
    worker.onmessage?.({ data: { type: "video", frames: [frame] } } as MessageEvent);
    worker.onmessage?.({ data: { type: "audio", chunks: [chunk] } } as MessageEvent);
    expect(presenter.offer).toHaveBeenCalledWith(frame);
    expect(audio.push).toHaveBeenCalledWith(chunk);
  });

  it("resets the decoder and drops queued audio on a seek", async () => {
    const { session, posted, audio, presenter } = harness();
    await session.start();
    posted.length = 0;
    session.seek(31);
    expect(posted[0].type).toBe("reset");
    expect(audio.flush).toHaveBeenCalledOnce();
    expect(presenter.destroy).toHaveBeenCalledOnce();
  });

  it("re-fetches the segment a seek landed in", async () => {
    const { session, fetched } = harness();
    await session.start();
    fetched.length = 0;
    session.seek(31);
    await session.poll();
    expect(fetched).toContain("/api/raw/abc/00005.ts");
  });

  it("fails when the worker reports an error", async () => {
    const { session, worker } = harness();
    await session.start();
    worker.onmessage?.({ data: { type: "error", message: "bad packet" } } as MessageEvent);
    expect(session.failure).toBe("decode error");
  });

  it("fails when no frame is presented before the deadline", async () => {
    let nowMs = 0;
    const { session } = harness({ nowMs: () => nowMs });
    await session.start();
    nowMs = 6000;
    session.tick();
    expect(session.failure).toBe("no first frame");
  });

  it("does not fail once frames are flowing", async () => {
    let nowMs = 0;
    const { session, presenter } = harness({ nowMs: () => nowMs });
    await session.start();
    presenter.presentedCount = 3;
    session.tick();
    nowMs = 60000;
    session.tick();
    expect(session.failure).toBeNull();
  });

  it("terminates the worker and tears down audio on destroy", async () => {
    const { session, worker, audio, presenter } = harness();
    await session.start();
    session.destroy();
    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(audio.destroy).toHaveBeenCalledOnce();
    expect(presenter.destroy).toHaveBeenCalled();
  });

  it("survives a failed poll rather than ending the session", async () => {
    const { session } = harness({
      fetchText: async () => { throw new Error("backend restarted"); },
    });
    await session.start();
    expect(session.failure).toBeNull();
  });
});

describe("createWasmSurface", () => {
  it("presents the session through the PlaybackSurface contract", async () => {
    const { session } = harness();
    await session.start();
    const surface = createWasmSurface(session);

    expect(surface.currentTime).toBe(36);
    expect(surface.seekable).toEqual([30, 42]);
    expect(surface.duration).toBeNull();   // live has no length
    expect(surface.paused).toBe(false);

    surface.pause();
    expect(surface.paused).toBe(true);
    await surface.play();
    expect(surface.paused).toBe(false);
  });

  it("mutes without pausing, so the picture keeps playing", async () => {
    // Suspending the context to mute would stop the clock, and the clock is
    // what video is presented against: the picture would freeze with it.
    const { session, audio } = harness();
    await session.start();
    const surface = createWasmSurface(session);

    surface.setMuted(true);

    expect(audio.setMuted).toHaveBeenCalledWith(true);
    expect(audio.suspend).not.toHaveBeenCalled();
    expect(surface.paused).toBe(false);
    expect(surface.muted).toBe(true);
  });

  it("describes itself for the debug snapshot", async () => {
    const { session } = harness();
    await session.start();
    expect(createWasmSurface(session).diagnostics()).toMatchObject({ kind: "wasm" });
  });

  it("reports a decode failure as the surface error", async () => {
    const { session, worker } = harness();
    await session.start();
    const surface = createWasmSurface(session);
    worker.onmessage?.({ data: { type: "error", message: "bad packet" } } as MessageEvent);
    expect(surface.error).toBe("decode error");
  });
});
