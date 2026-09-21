import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { SKIP_BADGE_LINGER_MS, SKIP_DEBOUNCE_MS } from "../lib/playback";
import { api } from "../api/tablo";
import type { Recording } from "../api/tablo";

/**
 * The badge over a run of skip taps.
 *
 * A burst is held back for `SKIP_DEBOUNCE_MS` before a single seek commits, so
 * for up to half a second after the last tap the only thing that can say where
 * the playhead is heading is this badge. It reports net movement rather than a
 * tap count, because the two directions are configured separately: with the
 * defaults, three taps forward and nine back are twelve presses and nowhere.
 */

const REC = {
  object_id: 80888, identifier: 80888, path: "/recordings/airings/80888",
  title: "NFL Football", subtitle: null, description: null,
  start: new Date(Date.now() - 3600_000).toISOString(),
  duration: 3600, recorded_seconds: null, state: "finished",
  channel: null, thumbnail: null, watched: false, position: 0,
} as unknown as Recording;

function stubSeekable(end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => end }),
  });
}

/**
 * The run a skip is allowed to move through.
 *
 * Needed explicitly here: jsdom plays no HLS, so the encoder report never
 * arrives and `readyRange` would otherwise collapse to the playhead and pin
 * every tap where it stands — a burst of nothing, and no badge to describe it.
 */
function stubBuffered(start: number, end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "buffered", {
    configurable: true,
    get: () => ({ length: 1, start: () => start, end: () => end }),
  });
}

function renderRecording() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer source={{ kind: "recording", recording: REC }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** Ten minutes in, with the whole hour cached: every tap below is free to land. */
const PLAYHEAD = 600;

const badge = () => screen.queryByRole("status", { name: /skipping/i });

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

function tap(key: "ArrowLeft" | "ArrowRight", times: number) {
  for (let i = 0; i < times; i++) fireEvent.keyDown(window, { key });
}

describe("the skip burst badge", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(HTMLMediaElement.prototype, "currentTime", "get").mockReturnValue(PLAYHEAD);
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      playlist_url: "/api/recordings/80888/playlist.m3u8", duration: 3600,
    } as never);
    vi.spyOn(api, "watchRecordingVod").mockRejectedValue(new Error("no vod"));
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      state: "complete", duration: 3600, progress: 1, cached_seconds: 3600,
    } as never);
    stubSeekable(3600);
    stubBuffered(0, 3600);
    window.localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

  it("stays out of the way until a tap lands", async () => {
    renderRecording();
    await settle();
    expect(badge()).toBeNull();
  });

  it("says how far forward the queue has got, and where that lands", async () => {
    renderRecording();
    await settle();

    tap("ArrowRight", 3);                       // 3 x 30s, from 10:00

    expect(badge()).toBeTruthy();
    expect(badge()!.textContent).toContain("+1:30");
    expect(badge()!.textContent).toContain("11:30");
  });

  it("signs a backward queue negative", async () => {
    renderRecording();
    await settle();

    tap("ArrowLeft", 2);                        // 2 x 10s back

    expect(badge()!.textContent).toContain("−0:20");
    expect(badge()!.textContent).toContain("9:40");
  });

  it("nets a mixed burst out rather than counting the taps", async () => {
    renderRecording();
    await settle();

    tap("ArrowRight", 3);                       // +90s
    tap("ArrowLeft", 9);                        // -90s

    // Twelve presses. The honest report is that the playhead has not moved,
    // and a tap count would have said "x12" about exactly that.
    expect(badge()!.textContent).toContain("0:00");
    expect(badge()!.textContent).not.toContain("12");
    expect(badge()!.textContent).toContain("10:00");
  });

  it("goes away once the seek has landed", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    renderRecording();
    await act(async () => { vi.advanceTimersByTime(200); });

    tap("ArrowRight", 2);
    expect(badge()).toBeTruthy();

    // The taps stop, the seek commits, and the badge holds just long enough to
    // be read before clearing itself.
    await act(async () => { vi.advanceTimersByTime(SKIP_DEBOUNCE_MS + 60); });
    expect(badge()).toBeTruthy();

    await act(async () => { vi.advanceTimersByTime(SKIP_BADGE_LINGER_MS + 60); });
    expect(badge()).toBeNull();
  });

  it("gets out of the way when a scrub takes the playhead", async () => {
    // The badge is measured from where the burst began. A seek from anywhere
    // else — this one through the scrubber's own keyboard, the same path Go
    // Live and a resume take — makes that origin a lie, so the queue and the
    // badge describing it go together.
    renderRecording();
    await settle();

    tap("ArrowRight", 2);
    expect(badge()).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("slider", { name: /seek/i }), { key: "PageUp" });

    expect(badge()).toBeNull();
  });

  it("is not part of the chrome that fades away", async () => {
    // The media keys skip without ever waking the controls - an AirPod squeeze
    // reaches the player through the Media Session API and touches nothing
    // else - so a badge inside the fading layer would answer a hidden screen.
    const { container } = renderRecording();
    await settle();

    tap("ArrowRight", 1);

    const chrome = container.querySelector(".transition-opacity");
    expect(chrome).toBeTruthy();
    expect(badge()).toBeTruthy();
    expect(chrome!.contains(badge()!)).toBe(false);
  });
});
