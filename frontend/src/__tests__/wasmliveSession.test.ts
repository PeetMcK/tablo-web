import { describe, it, expect, vi } from "vitest";

import {
  createSession, CLOSE_GRACE_MS, GROWING_MAX_AGE_MS, LOOKAHEAD_SECONDS,
  POLL_INTERVAL_MS, STARVED_LOOKAHEAD_SECONDS,
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
  const posted: { type: string; bytes?: ArrayBuffer; epoch?: number }[] = [];
  const fetched: string[] = [];
  let clockSeconds: number | null = 36;
  let bufferedSeconds = 0;
  let contextState: AudioContextState = "running";

  const worker = {
    postMessage: (m: { type: string; bytes?: ArrayBuffer; epoch?: number }) => posted.push(m),
    terminate: vi.fn(),
    onmessage: null as ((e: MessageEvent) => void) | null,
    onerror: null as ((e: Event) => void) | null,
    onmessageerror: null as ((e: Event) => void) | null,
  };

  const audio = {
    push: vi.fn(),
    get clockSeconds() { return clockSeconds; },
    get bufferedSeconds() { return bufferedSeconds; },
    get contextState() { return contextState; },
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
    setContextState: (s: AudioContextState) => { contextState = s; },
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
        type: "audio", epoch: 0,
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
        type: "audio", epoch: 0,
        chunks: [{ ptsSeconds: 9000, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);

    session.seek(31);
    await session.poll();
    // The worker confirms the decoder was rebuilt, and everything it decodes
    // from here carries the new epoch.
    worker.onmessage?.({ data: { type: "reset", epoch: 1 } } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "audio", epoch: 1,
        chunks: [{ ptsSeconds: 8500, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);
    setClock(8500);

    expect(session.currentTime).toBe(30);
  });

  it("ignores media the worker decoded before the seek", async () => {
    // Messages already in flight carry the old position, and audio anchors the
    // clock — so one stale chunk landing after the flush puts the playhead back
    // where the viewer just left while frames arrive from where they went.
    // Measured on a press of Back 10s: "starved by 12.32s" twice in the same
    // millisecond, and the channel handed back to the transcode before a single
    // new frame was drawn.
    const { session, worker, audio, presenter } = harness();
    await session.start();

    session.seek(31);
    audio.push.mockClear();
    presenter.offer.mockClear();

    worker.onmessage?.({
      data: {
        type: "audio", epoch: 0,
        chunks: [{ ptsSeconds: 9000, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);
    worker.onmessage?.({
      data: { type: "video", epoch: 0, frames: [{ ptsSeconds: 9000 }] },
    } as MessageEvent);
    expect(audio.push).not.toHaveBeenCalled();
    expect(presenter.offer).not.toHaveBeenCalled();

    // And takes everything decoded at the new position.
    worker.onmessage?.({ data: { type: "reset", epoch: 1 } } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "audio", epoch: 1,
        chunks: [{ ptsSeconds: 8500, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);
    expect(audio.push).toHaveBeenCalledOnce();
  });

  it("drops a segment whose fetch was still in flight when a seek happened", async () => {
    // The half the reset acknowledgement never covered. The gate could only
    // filter messages in flight *from the worker*; a fetch in flight *from the
    // page* resumed afterwards and posted its bytes after the reset, so the
    // worker decoded the old position on top of the new one and the first
    // chunk of audio re-anchored the clock ten seconds away from every frame
    // arriving. The test that was supposed to catch this resolved `fetchBytes`
    // synchronously, which is exactly why it could not.
    let release: (bytes: ArrayBuffer) => void = () => {};
    let outstanding = false;
    const h = harness({
      // Only the first fetch is held open; the seek's own poll must be able to
      // finish, or the chain never settles.
      fetchBytes: async (url: string) => {
        if (outstanding) return new ArrayBuffer(8);
        outstanding = true;
        void url;
        return new Promise<ArrayBuffer>((resolve) => { release = resolve; });
      },
    });

    const polling = h.session.poll();
    // Let the poll get as far as the segment fetch, which is the state this is
    // about: bytes on their way to a page that is about to seek away.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(outstanding).toBe(true);

    h.session.seek(31);
    // Distinctive bytes, because the stamp cannot tell this story: a stale
    // segment posted after the seek carries the *new* epoch — `post` reads the
    // variable the seek just bumped — so the worker would decode the old
    // position believing it to be the new one. The bytes are the evidence.
    release(new ArrayBuffer(99));
    await polling;

    const segments = h.posted.filter((m) => m.type === "segment");
    expect(segments.some((m) => m.bytes?.byteLength === 99)).toBe(false);
  });

  it("leaves no window open between two seeks in quick succession", async () => {
    // The acknowledgement cleared on the *first* reset, so everything the old
    // decoder produced between the two passed the gate. An epoch has no such
    // window: media is compared against where playback is now, not against
    // whether an acknowledgement has arrived.
    const { session, worker, audio } = harness();
    await session.start();

    session.seek(31);
    session.seek(35);
    audio.push.mockClear();

    worker.onmessage?.({ data: { type: "reset", epoch: 1 } } as MessageEvent);
    worker.onmessage?.({
      data: {
        type: "audio", epoch: 1,
        chunks: [{ ptsSeconds: 9000, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);

    expect(audio.push).not.toHaveBeenCalled();
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
    worker.onmessage?.({ data: { type: "video", epoch: 0, frames: [frame] } } as MessageEvent);
    worker.onmessage?.({ data: { type: "audio", epoch: 0, chunks: [chunk] } } as MessageEvent);
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

  it("seeks to the live edge, not the front of the window, when asked past the end", async () => {
    // Dragging the scrubber to the right-hand end. The target lands at or past
    // the window end about half the time — the range end the player clamps to
    // is up to half a second stale and the ring grows every second — and the
    // session used to answer that by feeding from `mediaSequence`, up to an
    // hour behind where the viewer was pointing.
    const h = harness({ fetchText: async () => DEEP_PLAYLIST });
    h.setClock(null);
    await h.session.start();
    h.fetched.length = 0;

    h.session.seek(1000);              // well past a 60s window
    await h.session.poll();

    const taken = h.fetched.filter((u) => u.endsWith(".ts"));
    expect(taken.length).toBeGreaterThan(0);
    expect(taken.some((u) => u.includes("00000.ts"))).toBe(false);
    expect(taken[0]).toContain("00039.ts");
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
    // Frames flowing means the count keeps moving; a count that stands still
    // while the clock runs is the frozen picture, which is a different test.
    for (let i = 1; i <= 60; i++) {
      presenter.presentedCount = i * 3;
      nowMs = i * 1000;
      session.tick();
    }
    expect(session.failure).toBeNull();
  });

  it("gives up on a picture that has stopped dead", async () => {
    // The one failure starvation cannot see. It measures how far the clock has
    // outrun the newest frame, and a stopped clock never outruns anything - so
    // a session wedged with a full queue and an empty audio buffer sat on a
    // still picture indefinitely, with nothing to hand the channel back.
    let nowMs = 0;
    const { session, presenter } = harness({ nowMs: () => nowMs });
    await session.start();
    presenter.presentedCount = 120;      // it was playing
    session.tick();

    nowMs = 30000;                        // and then it was not
    session.tick();

    expect(session.failure).toBe("decode error");
    expect(String(session.diagnostics().failureDetail)).toMatch(/nothing drawn/);
  });

  it("does not give up while the audio context is suspended", async () => {
    // A context created without user activation behind it starts suspended: a
    // deep link, a background tab, a first visit under Chrome's autoplay
    // policy. Suspended, the worklet renders nothing, the clock never
    // advances, no field is ever due and nothing is presented — which is
    // indistinguishable from a broken decoder, and used to be failed as one
    // after eight seconds, before the viewer could click anything.
    let nowMs = 0;
    const h = harness({ nowMs: () => nowMs });
    h.setContextState("suspended");
    await h.session.start();

    nowMs = 60000;
    h.session.tick();

    expect(h.session.failure).toBeNull();
  });

  it("does not count the wait against the session once the context starts", async () => {
    // Held, not skipped. Leaving the marks where they were means the first
    // tick after the viewer presses play looks back over the whole wait and
    // calls it a stall.
    let nowMs = 0;
    const h = harness({ nowMs: () => nowMs });
    h.setContextState("suspended");
    await h.session.start();

    nowMs = 60000;
    h.session.tick();
    h.setContextState("running");
    h.presenter.presentedCount = 1;
    h.session.tick();

    expect(h.session.failure).toBeNull();
  });

  it("does not end the session because the queue ran dry", async () => {
    // The old starvation rule ended it on two consecutive animation frames —
    // 33ms of an empty queue. A rebuffer is not a broken decoder, and the
    // frozen-picture watchdog already covers the failure that is.
    let nowMs = 0;
    const { session, worker, presenter } = harness({ nowMs: () => nowMs });
    await session.start();
    worker.onmessage?.({
      data: {
        type: "audio", epoch: 0,
        chunks: [{ ptsSeconds: 36, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);

    // Drawing, then nothing queued for a good while — but still drawing.
    for (let i = 1; i <= 200; i++) {
      presenter.presentedCount = i;
      presenter.queued = 0;
      nowMs = i * 100;
      session.tick();
    }

    expect(session.failure).toBeNull();
  });

  it("says it is playing again once there is something to draw", async () => {
    // `waiting` used to be emitted with no matching `playing`, and the stall
    // overlay clears only on `playing` — so one spurious event left "stalled"
    // on screen until the session was replaced.
    const events: string[] = [];
    const { session, worker, presenter } = harness();
    await session.start();
    session.on("waiting", () => events.push("waiting"));
    session.on("playing", () => events.push("playing"));
    worker.onmessage?.({
      data: {
        type: "audio", epoch: 0,
        chunks: [{ ptsSeconds: 36, samples: new Float32Array(2), sampleRate: 48000 }],
      },
    } as MessageEvent);

    presenter.queued = 0;
    session.tick();
    session.tick();                    // still empty: one event, not two
    presenter.queued = 40;
    session.tick();

    expect(events).toEqual(["waiting", "playing"]);
  });

  it("does not call an empty queue a stall before any audio has arrived", async () => {
    // Startup has an empty queue by definition. Calling that a stall would put
    // the spinner up on every channel change.
    const events: string[] = [];
    const { session, presenter } = harness();
    await session.start();
    session.on("waiting", () => events.push("waiting"));

    presenter.queued = 0;
    session.tick();

    expect(events).toEqual([]);
  });

  it("lets the worker free its decoder before terminating it", async () => {
    // This used to post `close` and call `terminate()` on the next line, which
    // kills the thread before it dequeues the message — so the decoder's own
    // teardown never ran, and everything in it was dead code that had never
    // executed in production.
    const { session, worker, posted, audio, presenter } = harness();
    await session.start();
    posted.length = 0;

    session.destroy();

    expect(posted.map((m) => m.type)).toContain("close");
    expect(worker.terminate).not.toHaveBeenCalled();

    worker.onmessage?.({ data: { type: "closed" } } as MessageEvent);

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(audio.destroy).toHaveBeenCalledOnce();
    expect(presenter.destroy).toHaveBeenCalled();
  });

  it("terminates a worker that never answers, rather than leaving the thread", async () => {
    vi.useFakeTimers();
    try {
      const { session, worker } = harness();
      await session.start();
      session.destroy();

      vi.advanceTimersByTime(CLOSE_GRACE_MS + 1);

      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminates once, however the close resolves", async () => {
    vi.useFakeTimers();
    try {
      const { session, worker } = harness();
      await session.start();
      session.destroy();
      worker.onmessage?.({ data: { type: "closed" } } as MessageEvent);
      vi.advanceTimersByTime(CLOSE_GRACE_MS + 1);

      expect(worker.terminate).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let scheduled polls pile up behind a slow one", async () => {
    // Polls are chained so two cannot claim the same segments, but chaining on
    // its own only defers: a poll that outlasts the 500ms interval — remote
    // access, a proxied backend, one slow segment — leaves the next tick queued
    // behind it, and the one after that, without bound. Each then runs against
    // a playlist minutes out of date.
    let scheduled: (() => void) | null = null;
    let defer = false;
    let release: (text: string) => void = () => {};
    let playlistFetches = 0;
    // Several turns: a queued poll is a chain of awaits, and one macrotask is
    // not enough for three of them to run.
    const settle = async () => {
      for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0));
    };

    const h = harness({
      schedule: (callback) => { scheduled = callback; return () => {}; },
      fetchText: async () => {
        playlistFetches += 1;
        if (!defer) return DEEP_PLAYLIST;
        return new Promise<string>((resolve) => { release = resolve; });
      },
    });
    h.setClock(null);
    await h.session.start();

    defer = true;
    const slow = h.session.poll();
    await settle();
    const before = playlistFetches;

    scheduled!();
    scheduled!();
    scheduled!();
    await settle();
    defer = false;
    release(DEEP_PLAYLIST);
    await slow;
    await settle();

    // Nothing queued behind the slow poll, so nothing ran once it finished.
    expect(playlistFetches).toBe(before);
  });

  it("calls a worker that has been running for a while a decode failure", async () => {
    // "init failed" is the first thing anyone reads when working out why a
    // channel fell back, and a worker that booted, opened and ran for a minute
    // before throwing did not fail to initialise.
    const { session, worker } = harness();
    await session.start();
    worker.onmessage?.({ data: { type: "booted" } } as MessageEvent);

    worker.onerror?.({ message: "out of memory" } as unknown as Event);

    expect(session.failure).toBe("decode error");
  });

  it("reports a failure once, not on every animation frame", async () => {
    let nowMs = 0;
    const errors: string[] = [];
    const { session, presenter } = harness({ nowMs: () => nowMs });
    await session.start();
    session.on("error", () => errors.push("error"));

    presenter.presentedCount = 10;
    session.tick();
    nowMs = 30000;
    for (let i = 0; i < 10; i++) session.tick();

    expect(session.failure).toBe("decode error");
    expect(errors).toHaveLength(1);
  });

  it("survives a failed poll rather than ending the session", async () => {
    const { session } = harness({
      fetchText: async () => { throw new Error("backend restarted"); },
    });
    await session.start();
    expect(session.failure).toBeNull();
  });
});

describe("a finished recording", () => {
  it("reads the index once, because it will never change", async () => {
    // The live path re-reads every poll because its window slides. A recording
    // carries EXT-X-ENDLIST: re-fetching 1.2MB of playlist twice a second buys
    // nothing at all.
    let playlistFetches = 0;
    const h = harness({
      vod: { durationSeconds: 600 },
      fetchText: async () => { playlistFetches += 1; return DEEP_PLAYLIST; },
    });
    h.setClock(null);
    await h.session.start();
    await h.session.poll();
    await h.session.poll();

    expect(playlistFetches).toBe(1);
  });

  it("starts at the beginning, not near the live edge", async () => {
    // Joining near the edge exists so a live viewer is not a minute behind the
    // broadcast. For something already recorded it just skips the first hour.
    const h = harness({
      vod: { durationSeconds: 600 },
      fetchText: async () => DEEP_PLAYLIST,
    });
    h.setClock(null);
    await h.session.start();

    const taken = h.fetched.filter((u) => u.endsWith(".ts"));
    expect(taken.length).toBeGreaterThan(0);
    expect(taken[0]).toContain("00000.ts");
  });

  it("reports the whole runtime as seekable, not what it has fetched", async () => {
    // What lets the scrubber show 215 minutes and a seek land anywhere in them.
    const h = harness({
      vod: { durationSeconds: 12913 },
      fetchText: async () => DEEP_PLAYLIST,
    });
    h.setClock(null);
    await h.session.start();

    expect(h.session.seekable).toEqual([0, 12913]);
  });

  it("still paces its feeding like the live path", async () => {
    // The whole point of the VOD mode being three small differences: a fixed
    // index must not become a licence to swallow three hours of media.
    const h = harness({
      vod: { durationSeconds: 600 },
      fetchText: async () => DEEP_PLAYLIST,
    });
    h.setClock(null);
    h.setBuffered(0);
    await h.session.start();

    const taken = h.fetched.filter((u) => u.endsWith(".ts")).length;
    expect(taken).toBeLessThanOrEqual(3);
    expect(DEEP_PLAYLIST.match(/\.ts/g)!.length).toBeGreaterThan(taken);
  });
});

// What the backend serves for a recording: no dates, because media time is
// elapsed time from zero, and no ENDLIST while it is still being written.
const vodPlaylist = (segments: number) => `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXT-X-MEDIA-SEQUENCE:0
${Array.from({ length: segments }, (_, i) =>
  `#EXTINF:1.500,\n${String(i).padStart(5, "0")}.ts`).join("\n")}
`;

describe("a recording that is still being written", () => {
  it("re-reads its index, because the device is still appending to it", async () => {
    // The opposite of the finished case above, for the opposite reason: the
    // start never moves, but the end is a frontier the viewer is behind.
    let playlistFetches = 0;
    let clockMs = 0;
    const h = harness({
      vod: { durationSeconds: 60, growing: true },
      nowMs: () => clockMs,
      fetchText: async () => { playlistFetches += 1; return vodPlaylist(40); },
    });
    h.setClock(null);
    await h.session.start();
    clockMs = GROWING_MAX_AGE_MS + 1;
    await h.session.poll();

    expect(playlistFetches).toBe(2);
  });

  it("does not re-read it on every poll, because feeding waits on that read", async () => {
    // Measured: the backend's refresh of the device playlist takes ~330ms and
    // the body is 70KB, so re-reading every 500ms poll stalled one poll in six
    // inside the path that feeds the decoder. Feeding never got ahead of
    // playback, the picture froze, and the watchdog fell the whole session back
    // to the transcode about fifteen seconds in.
    let playlistFetches = 0;
    const h = harness({
      vod: { durationSeconds: 60, growing: true },
      nowMs: () => 0,
      fetchText: async () => { playlistFetches += 1; return vodPlaylist(40); },
    });
    h.setClock(null);
    await h.session.start();
    for (let i = 0; i < 6; i++) await h.session.poll();

    expect(playlistFetches).toBe(1);
  });

  it("never makes a seek wait on a read", async () => {
    // A seek target is inside what is already held — `seekable` is derived from
    // it — so a fresh read cannot change where the seek lands. It would only
    // add latency to the one operation that has to feel instant.
    let clockMs = 0;
    let playlistFetches = 0;
    const h = harness({
      vod: { durationSeconds: 60, growing: true },
      nowMs: () => clockMs,
      fetchText: async () => { playlistFetches += 1; return vodPlaylist(40); },
    });
    h.setClock(null);
    await h.session.start();
    expect(playlistFetches).toBe(1);

    // Long past stale, so an unguarded seek would certainly re-read.
    clockMs = GROWING_MAX_AGE_MS * 10;
    h.session.seek(12);
    // `seek` kicks off its own poll; let it run. A later poll re-reading is
    // fine and expected — what must not happen is the seek waiting on one.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(playlistFetches).toBe(1);
    expect(h.fetched.filter((u) => u.endsWith(".ts")).length).toBeGreaterThan(0);
  });

  it("starts at its first frame, which is the whole point", async () => {
    // It was routed to the ring before this, and the ring joins at the live
    // edge — so opening a show forty minutes in began forty minutes in.
    const h = harness({
      vod: { durationSeconds: 60, growing: true },
      fetchText: async () => vodPlaylist(40),
    });
    h.setClock(null);
    await h.session.start();

    const taken = h.fetched.filter((u) => u.endsWith(".ts"));
    expect(taken.length).toBeGreaterThan(0);
    expect(taken[0]).toContain("00000.ts");
  });

  it("grows what can be seeked over as the recording grows", async () => {
    // Pinning the scrubber to the length at open would fence off everything
    // recorded since — on an hour-long show, most of it.
    let segments = 20;
    let clockMs = 0;
    const h = harness({
      vod: { durationSeconds: 30, growing: true },
      nowMs: () => clockMs,
      fetchText: async () => vodPlaylist(segments),
    });
    h.setClock(null);
    await h.session.start();
    expect(h.session.seekable).toEqual([0, 30]);

    segments = 60;
    clockMs = GROWING_MAX_AGE_MS + 1;
    await h.session.poll();

    expect(h.session.seekable).toEqual([0, 90]);
  });

  it("never reports a range shorter than the length it opened with", async () => {
    // A refresh that arrives empty or fails must not shrink the scrubber under
    // a viewer who is already past where it would shrink to.
    const h = harness({
      vod: { durationSeconds: 600, growing: true },
      fetchText: async () => vodPlaylist(4),
    });
    h.setClock(null);
    await h.session.start();

    expect(h.session.seekable).toEqual([0, 600]);
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
