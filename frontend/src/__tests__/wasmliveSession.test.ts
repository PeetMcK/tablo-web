import { describe, it, expect, vi } from "vitest";

import {
  createSession, LOOKAHEAD_SECONDS, POLL_INTERVAL_MS, STARVED_LOOKAHEAD_SECONDS,
} from "../lib/wasmlive/session";
import { MAX_QUEUED_FRAMES } from "../lib/wasmlive/frameQueue";
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
  let bufferedSeconds = 0;

  const worker = {
    postMessage: (m: { type: string }) => posted.push(m),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    onmessageerror: null as ((e: Event) => void) | null,
  };

  const audio = {
    push: vi.fn(),
    get clockSeconds() { return clockSeconds; },
    get bufferedSeconds() { return bufferedSeconds; },
    starvedBy: vi.fn(() => 0),
    setMuted: vi.fn(),
    muted: false,
    flush: vi.fn(),
    resume: vi.fn(async () => {}),
    suspend: vi.fn(async () => {}),
    destroy: vi.fn(async () => {}),
    diagnostics: () => ({ audioContext: "running" }),
  };

  const presenter = {
    offer: vi.fn(),
    tick: vi.fn(),
    newestPts: null as number | null,
    oldestPts: null as number | null,
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
    setBuffered: (s: number) => { bufferedSeconds = s; },
  };
}

/** A window with a minute of backlog, the way a running ring looks. */
const DEEP_PLAYLIST = `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PROGRAM-DATE-TIME:2026-09-16T20:00:00+00:00
${Array.from({ length: 40 }, (_, i) => `#EXTINF:1.500,\n${String(i).padStart(5, "0")}.ts`).join("\n")}
`;

describe("pacing", () => {
  it("starts near the live edge, not at the front of the window", async () => {
    // Live means live. Starting at the oldest segment the ring still holds
    // puts the viewer a minute behind before they have seen a frame.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    await h.session.start();

    const fetched = h.fetched.filter((u) => u.endsWith(".ts"));
    expect(fetched.length).toBeGreaterThan(0);
    // Forty segments of 1.5s is a minute of window. Ten seconds back from its
    // end lands on the sixth from last - nine seconds of runway, since a
    // seventh would overshoot. Not the front of the window, and not so close
    // to the end that one slow device poll leaves nothing to play.
    expect(fetched[0]).toContain("00034.ts");
    expect(fetched.some((u) => u.includes("00000.ts"))).toBe(false);
  });

  it("paces the very first poll, before any clock exists", async () => {
    // A seek into the middle of a deep window: there is a minute of material
    // ahead and no audio has played yet, so there is no clock to pace
    // against. Treating that as "no limit" is what made the first live run
    // fetch 50 seconds of media in one go and evict all of it undrawn.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    await h.session.start();
    h.fetched.length = 0;
    h.session.seek(5);
    await h.session.poll();

    const takenUrls = h.fetched.filter((u) => u.endsWith(".ts"));
    const taken = takenUrls.length;
    expect(taken).toBeGreaterThan(0);
    // And each exactly once: two polls in flight must not both claim them.
    expect(new Set(takenUrls).size).toBe(taken);
  });

  it("stops fetching once enough audio is buffered", async () => {
    // Decode runs at 8x realtime. Without a limit the session swallows the
    // whole backlog and the field queue fills with frames the clock will not
    // reach for a minute - which is exactly what the first live run did.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    await h.session.start();
    const firstBatch = h.fetched.filter((u) => u.endsWith(".ts")).length;

    h.setBuffered(10);
    await h.session.poll();

    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBe(firstBatch);
  });

  it("fetches more as playback consumes what it has", async () => {
    // Rewound into the middle of the window, where there is a minute of
    // material ahead: what is taken has to follow playback rather than
    // arriving all at once.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(10);
    h.setBuffered(10);
    await h.session.start();
    h.session.seek(10);
    await h.session.poll();
    const before = h.fetched.filter((u) => u.endsWith(".ts")).length;

    // Five seconds play out, so the lookahead is no longer satisfied.
    h.setClock(15);
    h.setBuffered(0.2);
    await h.session.poll();

    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBeGreaterThan(before);
  });

  it("fetches past the lookahead when the clock has stalled and the buffer is empty", async () => {
    // The deadlock the first live run hit: audio ran dry, so the clock
    // stopped, so nothing was fetched, so audio never came back. Buffer depth
    // breaks it, because it falls to zero rather than freezing.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    h.setBuffered(0);
    await h.session.start();

    // More than the ordinary lookahead of 1.25s, which at 1.5s a segment is
    // one; enough audio to get the clock moving again.
    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBeGreaterThan(1);
  });

  it("widens the lookahead when starving rather than matching it", async () => {
    // Both ends matter. Equal to the ordinary lookahead the escape does
    // nothing at all; above what the field queue holds, relieving starvation
    // just causes it somewhere else.
    expect(STARVED_LOOKAHEAD_SECONDS).toBeGreaterThan(LOOKAHEAD_SECONDS);
    expect(STARVED_LOOKAHEAD_SECONDS).toBeLessThanOrEqual(MAX_QUEUED_FRAMES / 59.94);
  });

  it("does not feed a decoder whose field queue is already full", async () => {
    // The decoder is not paced by the media limit: a segment handed over
    // becomes forty-five frames in fifty milliseconds. Landing those on a full
    // queue means the excess is refused, and refused fields are a hole in the
    // timeline rather than a short queue - measured as presentation stopping
    // dead for 300ms with 104 fields held and the oldest 0.286s in the future.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    h.setBuffered(5);
    h.presenter.queued = MAX_QUEUED_FRAMES;
    await h.session.start();

    expect(h.fetched.filter((u) => u.endsWith(".ts"))).toEqual([]);
  });

  it("feeds a starving decoder even so, because silence stops the clock", async () => {
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    h.setBuffered(0);
    h.presenter.queued = MAX_QUEUED_FRAMES;
    await h.session.start();

    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBeGreaterThan(0);
  });

  it("does not hold the audio buffer down on the starvation threshold", async () => {
    // The queue gate must not make the floor a set point. The floor is what
    // the fallback counts starvation events against, so a session pinned to it
    // is a session on its way to giving up: measured at exactly 0.5s held for
    // eighty-four seconds, drifting from ten seconds behind the live edge to
    // twenty, then "repeated starvation".
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    h.setBuffered(0.6);                  // above the floor, nowhere near comfortable
    h.presenter.queued = MAX_QUEUED_FRAMES;
    await h.session.start();

    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBeGreaterThan(0);
  });

  it("asks for more media more often than playback consumes it", async () => {
    // These two are a pair, and nothing else makes them one. Polling used to
    // run at half the playlist's target duration - 1.5s for this device's ring
    // - against a lookahead of 1.25s, so every cycle fed a quarter of a second
    // less than playback ate and the queue drained to empty between polls.
    expect(POLL_INTERVAL_MS / 1000).toBeLessThan(LOOKAHEAD_SECONDS);
  });

  it("does not swallow the ring while the buffer is empty", async () => {
    // The starvation escape used to bypass pacing outright rather than widen
    // it, and at startup the buffer is empty by definition — so the first poll
    // fed the whole primed window in one pass. The audio sink keeps everything
    // it is given; the field queue can only hold a couple of seconds and
    // refused the rest, so video ran dry and never recovered while audio
    // played on. Measured on the device at 5.7s buffered against a field queue
    // running a second behind.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    h.setBuffered(0);
    await h.session.start();

    const fetched = h.fetched.filter((u) => u.endsWith(".ts")).length;
    // DEEP_PLAYLIST is far longer than the starved lookahead of 2s allows.
    expect(fetched).toBeLessThanOrEqual(3);
    expect(DEEP_PLAYLIST.match(/\.ts/g)!.length).toBeGreaterThan(fetched);
  });
});

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

  it("reports the playhead in media time, not the device's timeline", async () => {
    // Decoded timestamps carry the broadcast's own PTS, which starts wherever
    // it happens to; the window is seconds since the session opened. Reported
    // raw, the playhead and the seekable range disagree by the gap between
    // those two origins — 90 seconds of it, on the first live run.
    const { session, worker, setClock } = harness();
    setClock(null);
    await session.start();

    // The first chunk of the segment at the live edge (36s in) carries a PTS
    // of 9000: everything after this is offset by the difference.
    worker.onmessage?.({
      data: {
        type: "audio",
        chunks: [{ ptsSeconds: 9000, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);
    setClock(9002);

    expect(session.currentTime).toBe(38);
    const [start, end] = session.seekable!;
    expect(session.currentTime).toBeGreaterThanOrEqual(start);
    expect(session.currentTime).toBeLessThanOrEqual(end);
  });

  it("re-derives the offset after a seek", async () => {
    const { session, worker, setClock } = harness();
    setClock(null);
    await session.start();
    worker.onmessage?.({
      data: {
        type: "audio",
        chunks: [{ ptsSeconds: 9000, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);

    session.seek(31);
    await session.poll();
    worker.onmessage?.({
      data: {
        type: "audio",
        chunks: [{ ptsSeconds: 8500, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);
    setClock(8500);

    expect(session.currentTime).toBe(30);
  });

  it("fetches segments from the playlist's own directory", async () => {
    const { session, fetched } = harness();
    await session.start();
    // The segment at the live edge, resolved against the playlist's path.
    expect(fetched).toContain("/api/raw/abc/00006.ts");
  });

  it("sends fetched segment bytes to the worker", async () => {
    const { session, posted } = harness();
    await session.start();
    expect(posted.filter((m) => m.type === "segment").length).toBeGreaterThan(0);
  });

  it("fetches each segment once as the window slides", async () => {
    const { session, fetched, slide, setClock } = harness();
    await session.start();
    slide();
    // Playback has moved on, so there is room for what the slide brought.
    setClock(44);
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
    const { session, fetched, setClock } = harness();
    await session.start();
    fetched.length = 0;
    // A seek moves the clock with it; the sink's first chunk sets it there.
    setClock(31);
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
    nowMs = 20000;
    session.tick();
    expect(session.failure).toBe("no first frame");
  });

  it("does not start the deadline until the decoder has been fed", async () => {
    // A freshly opened ring is empty for a few seconds while the device
    // produces its first segments. Counting that against the decoder gave up
    // before there was anything to decode — and on a cold channel that was
    // every time.
    let nowMs = 0;
    const empty = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:0\n";
    const { session } = harness({ nowMs: () => nowMs, fetchText: async () => empty });
    await session.start();

    nowMs = 60000;
    session.tick();

    expect(session.failure).toBeNull();
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

describe("saying why it failed", () => {
  it("fails over when the worker itself will not load", async () => {
    // A module worker whose script or wasm asset 404s reports through onerror
    // and nowhere else: onmessage stays silent, so without this the session
    // looks exactly like a decoder producing nothing, and times out instead of
    // failing over at once.
    const { session, worker } = harness();
    await session.start();

    worker.onerror?.({ message: "Failed to fetch worker" } as unknown as Event);

    expect(session.failure).toBe("init failed");
    expect(session.diagnostics().failureDetail).toBe("Failed to fetch worker");
  });

  it("names a worker error even when the event carries no message", async () => {
    const { session, worker } = harness();
    await session.start();

    worker.onerror?.({} as Event);

    expect(session.failure).toBe("init failed");
    expect(session.diagnostics().failureDetail).toBe("worker failed to load");
  });

  it("keeps the decoder's reason beside the fallback's category", async () => {
    const { session, worker } = harness();
    await session.start();

    worker.onmessage?.({
      data: { type: "error", message: "no video stream after 917504 bytes" },
    } as MessageEvent);

    // "decode error" says a rule tripped; the detail says what to go and fix.
    expect(session.failure).toBe("decode error");
    expect(session.diagnostics().failureDetail).toBe("no video stream after 917504 bytes");
  });

  it("reports the decoder's counters once the worker has sent them", async () => {
    const { session, worker } = harness();
    await session.start();

    expect(session.diagnostics().decoder).toBe(null);

    worker.onmessage?.({
      data: { type: "stats", stats: { opened: true, bytesFed: 4096, videoStream: false } },
    } as MessageEvent);

    expect(session.diagnostics().decoder).toEqual({
      opened: true, bytesFed: 4096, videoStream: false,
    });
  });
});
