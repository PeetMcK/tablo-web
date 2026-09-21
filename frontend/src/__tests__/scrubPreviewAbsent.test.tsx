import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, act, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Recording } from "../api/tablo";

/**
 * Recordings the device has no thumbnails for.
 *
 * Not every recording has a pack: a damaged capture never gets a snap grid
 * built (object 74776 on a real device: `clean: false`, `size: 0`,
 * `has_snap_grid: false`), and one still being written has none until minutes
 * after it ends. The strip used to ask anyway, once per hover position - forty
 * 404s in ten seconds, each answered from a device session that could only ever
 * say no.
 */

const REC = {
  object_id: 74776, identifier: 74776, path: "/recordings/sports/events/74776",
  title: "Denver Broncos at Kansas City Chiefs", subtitle: null, description: null,
  start: new Date(Date.now() - 3600_000).toISOString(),
  duration: 3600, recorded_seconds: null, state: "finished",
  channel: null, thumbnail: null, watched: false, position: 0,
} as unknown as Recording;

/** Every url an <img> was pointed at, and whether it was allowed to succeed. */
let asked: string[] = [];
let frameLoads = false;

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(url: string) {
    asked.push(url);
    queueMicrotask(() => (frameLoads ? this.onload?.() : this.onerror?.()));
  }
}

function renderRecording() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer source={{ kind: "recording", recording: REC }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

/** jsdom lays nothing out, so the bar has to be told how wide it is. */
function hover(container: HTMLElement, fraction: number) {
  const bar = container.querySelector<HTMLElement>('[class*="group/bar"]')!;
  bar.getBoundingClientRect = () => ({
    left: 0, width: 1000, top: 0, height: 20, bottom: 20, right: 1000,
    x: 0, y: 0, toJSON: () => "",
  }) as DOMRect;
  fireEvent.pointerMove(bar, { clientX: 1000 * fraction, clientY: 10 });
}

async function settle() {
  await act(async () => { await new Promise((r) => setTimeout(r, 50)); });
}

/** jsdom plays nothing, so the seekable range has to be described too. */
function stubRanges(end: number) {
  for (const prop of ["seekable", "buffered"] as const) {
    Object.defineProperty(HTMLMediaElement.prototype, prop, {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => end }),
    });
  }
}

describe("the scrub preview, on a recording that has none", () => {
  beforeEach(() => {
    asked = [];
    frameLoads = false;
    vi.stubGlobal("Image", FakeImage);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      playlist_url: "/api/recordings/74776/playlist.m3u8", duration: 3600,
    } as never);
    vi.spyOn(api, "watchRecordingVod").mockRejectedValue(new Error("no vod"));
    stubRanges(3600);
    window.localStorage.clear();
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("stops asking once a frame has failed to arrive", async () => {
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      state: "partial", duration: 3600, progress: 0.5, cached_seconds: 1800,
      preview: "absent",
    } as never);
    const { container } = renderRecording();
    await settle();

    hover(container, 0.2);
    await settle();
    const afterFirst = asked.length;

    hover(container, 0.4);
    hover(container, 0.6);
    await settle();

    expect(afterFirst).toBe(1);
    expect(asked.length).toBe(afterFirst);
  });

  it("asks for nothing at all once the poll has said there are none", async () => {
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      state: "partial", duration: 3600, progress: 0.5, cached_seconds: 1800,
      preview: "absent",
    } as never);
    const { container } = renderRecording();
    // The poll runs every three seconds, and it is the authority: a frame that
    // fails for some other reason is only a guess until it answers.
    await act(async () => { await new Promise((r) => setTimeout(r, 3200)); });

    hover(container, 0.3);
    await settle();

    expect(asked).toEqual([]);
  });

  it("keeps asking while the frames are arriving", async () => {
    frameLoads = true;
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      state: "partial", duration: 3600, progress: 0.5, cached_seconds: 1800,
      preview: "ready",
    } as never);
    const { container } = renderRecording();
    await settle();

    hover(container, 0.2);
    await settle();
    hover(container, 0.6);
    await settle();

    expect(asked.length).toBeGreaterThan(1);
    expect(asked[0]).toContain("/recordings/74776/preview?t=");
  });
});
