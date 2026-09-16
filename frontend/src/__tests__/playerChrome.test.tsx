import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";

const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};

const startedAt = new Date(Date.now() - 15 * 60 * 1000);
const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: startedAt.toISOString(), duration: 3600,
};

function stubSeekable(end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => end }),
  });
}

function renderLive() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer
        source={{ kind: "live", channel: CHANNEL, program: NEWS_HOUR }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** The fading chrome layer, and the surface the cursor rule lands on. */
const chrome = (c: HTMLElement) => c.querySelector<HTMLElement>(".transition-opacity")!;
const surface = (c: HTMLElement) => c.firstElementChild as HTMLElement;
/** The transport cluster — the region a resting cursor should hold open. */
const transport = (c: HTMLElement) =>
  c.querySelector<HTMLElement>(".flex.flex-col.gap-3.pointer-events-auto")!;

describe("the player's chrome", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/api/hls/abc/playlist.m3u8",
      stream_url: "/api/transcoded/abc/playlist.m3u8", transcoded: true,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "transcodeStatus").mockResolvedValue({
      status: "active", encoded_seconds: 900,
    });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    stubSeekable(900);
    // jsdom implements neither, and the button is gated on the API being
    // present — without this it renders nowhere and proves nothing.
    (window as unknown as Record<string, unknown>).documentPictureInPicture = {
      requestWindow: vi.fn(),
    };
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  it("holds the controls up while the cursor rests on the transport", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());

      fireEvent.mouseOver(transport(container));
      // Long past the point they would otherwise have faded.
      await act(async () => { vi.advanceTimersByTime(10_000); });
      expect(chrome(container).className).toContain("opacity-100");

      // Leaving starts the clock again.
      fireEvent.mouseOut(transport(container));
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(chrome(container).className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("still fades when the cursor is out over the picture", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());

      fireEvent.mouseMove(surface(container));
      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(chrome(container).className).toContain("opacity-0");
    } finally {
      vi.useRealTimers();
    }
  });

  it("takes the cursor away with the bar, and gives it back", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());
      expect(surface(container).className).not.toContain("cursor-none");

      await act(async () => { vi.advanceTimersByTime(4_000); });
      expect(surface(container).className).toContain("cursor-none");

      fireEvent.mouseMove(surface(container));
      await act(async () => {});
      expect(surface(container).className).not.toContain("cursor-none");
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps the browser's own floating button off the picture", async () => {
    // The only opt-out a page has. It is also why the pop-out below cannot
    // use `requestPictureInPicture`.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    // Asserted as the attribute: jsdom does not reflect the IDL property.
    expect(container.querySelector("video")!.hasAttribute("disablepictureinpicture"))
      .toBe(true);
  });

  it("offers the pop-out between sound and fullscreen", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    const titles = [...container.querySelectorAll("button")]
      .map((b) => b.getAttribute("title") ?? "")
      .filter((t) => /^(Mute|Unmute|Picture in picture|Fullscreen)/i.test(t));
    expect(titles).toEqual(["Mute (M)", "Picture in picture", "Fullscreen (F)"]);
  });

  /** Stand in for the window the browser would hand back. */
  function fakePipWindow() {
    const pipDoc = document.implementation.createHTMLDocument("pip");
    const listeners: Record<string, () => void> = {};
    const w = {
      document: pipDoc,
      close: vi.fn(() => listeners.pagehide?.()),
      addEventListener: vi.fn((type: string, fn: () => void) => { listeners[type] = fn; }),
      removeEventListener: vi.fn(),
    } as unknown as Window;
    const requestWindow = vi.fn().mockResolvedValue(w);
    (window as unknown as Record<string, unknown>).documentPictureInPicture = { requestWindow };
    return { w, pipDoc, requestWindow };
  }

  it("moves the whole stage across, carrying the video and its controls", async () => {
    // The video must travel rather than be re-rendered — the stream is
    // attached to that element through a MediaSource, so a second one would
    // start from nothing — and the transport has to travel with it, which is
    // the point of moving a stage rather than the bare picture.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { pipDoc, requestWindow } = fakePipWindow();

    const video = container.querySelector("video")!;
    fireEvent.click(screen.getByTitle("Picture in picture"));

    await waitFor(() => expect(requestWindow).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(pipDoc.body.contains(video)).toBe(true));

    // Same element, and the controls came with it.
    expect(pipDoc.body.querySelector("video")).toBe(video);
    expect(pipDoc.body.querySelector('[title="Back to the tab"]')).not.toBeNull();
    expect(pipDoc.body.querySelector('[aria-label="Back 10 seconds"]')).not.toBeNull();
    // Asked for nothing: placement is the browser's to remember.
    expect(requestWindow).toHaveBeenCalledWith();
  });

  it("carries the stylesheets over, or the controls arrive unstyled", async () => {
    // A pop-out window starts with no CSS whatsoever. jsdom under vitest loads
    // none of the app's either, so one is planted here — otherwise there is
    // nothing to copy and the assertion would pass on an empty loop.
    const planted = document.createElement("style");
    planted.textContent = ".glass{opacity:1}";
    document.head.append(planted);
    try {
      renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());
      const { pipDoc } = fakePipWindow();

      fireEvent.click(screen.getByTitle("Picture in picture"));
      await waitFor(() => expect(pipDoc.body.querySelector("video")).not.toBeNull());
      const carried = [...pipDoc.head.querySelectorAll("style")]
        .map((s) => s.textContent ?? "").join("");
      expect(carried).toContain(".glass");
    } finally {
      planted.remove();
    }
  });

  it("offers a way back in the tab it left, and takes it", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const { w, pipDoc } = fakePipWindow();
    const root = surface(container);

    fireEvent.click(screen.getByTitle("Picture in picture"));
    const restore = await waitFor(() => {
      const el = root.querySelector<HTMLElement>('[title="Bring the picture back"]');
      expect(el).not.toBeNull();
      return el!;
    });
    // The placeholder is only shown while the picture is away.
    expect(restore.closest("[hidden]")).toBeNull();

    fireEvent.click(restore);
    await waitFor(() => expect(w.close).toHaveBeenCalled());
    // Closing brings the stage home and hides the placeholder again.
    await waitFor(() => expect(root.contains(container.querySelector("video")!)).toBe(true));
    expect(pipDoc.body.querySelector("video")).toBeNull();
  });

  it("fullscreens the player, not the bare video element", async () => {
    // Fullscreening the <video> hands the browser's own controls to the
    // viewer and leaves our timeline — cache bands, thumbnail scrubbing,
    // skip buttons — outside the fullscreen element entirely.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    const onVideo = vi.fn();
    const onRoot = vi.fn();
    const video = container.querySelector("video")!;
    video.requestFullscreen = onVideo;
    surface(container).requestFullscreen = onRoot;

    fireEvent.click(screen.getByTitle(/fullscreen/i));

    expect(onRoot).toHaveBeenCalledTimes(1);
    expect(onVideo).not.toHaveBeenCalled();
  });
});
