import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { clampVolume, loadVolume, saveVolume, VOLUME_STORAGE_KEY } from "../lib/volume";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";

const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};

const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: new Date(Date.now() - 15 * 60 * 1000).toISOString(), duration: 3600,
};

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

const slider = () => screen.queryByRole("slider", { name: /volume/i });

describe("remembering a volume", () => {
  beforeEach(() => localStorage.clear());

  it("starts at full for anyone who never chose", () => {
    expect(loadVolume()).toBe(1);
  });

  it("keeps a level across reloads", () => {
    saveVolume(0.4);
    expect(loadVolume()).toBeCloseTo(0.4);
  });

  it("clamps and ignores nonsense rather than handing back a bad level", () => {
    // `video.volume` throws outside 0..1, so a corrupted entry would break
    // playback rather than merely sound wrong.
    saveVolume(4);
    expect(loadVolume()).toBe(1);
    saveVolume(-1);
    expect(loadVolume()).toBe(0);
    localStorage.setItem(VOLUME_STORAGE_KEY, "loud");
    expect(loadVolume()).toBe(1);
  });

  it("keeps the level to whole hundredths", () => {
    // Twelve presses of a twentieth landed on 0.39999999999999963 and stored
    // it verbatim. Binary floats do not add up to the step they are made of,
    // so every write is quantised where it funnels rather than at each of the
    // callers, which would leave the next one to rediscover it.
    saveVolume(0.1 + 0.05 + 0.05);
    expect(loadVolume()).toBe(0.2);
    expect(localStorage.getItem(VOLUME_STORAGE_KEY)).toBe("0.2");
    expect(clampVolume(1 - 0.05 * 12)).toBe(0.4);
  });

  it("survives storage that refuses to be read or written", () => {
    // Private mode throws on access. A player that cannot remember a level is
    // a small loss; one that throws on mount is not.
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("denied");
    });
    try {
      expect(() => saveVolume(0.5)).not.toThrow();
      expect(loadVolume()).toBe(1);
    } finally {
      get.mockRestore();
      set.mockRestore();
    }
  });
});

describe("the player's volume", () => {
  beforeEach(() => {
    localStorage.clear();
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
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (window as unknown as Record<string, unknown>).documentPictureInPicture;
  });

  it("opens at the level the last session left", async () => {
    saveVolume(0.35);
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    expect(container.querySelector("video")!.volume).toBeCloseTo(0.35);
  });

  it("moves in twentieths on the up and down arrows", async () => {
    // Left and Right are seek, so vertical is what is left — and it is what
    // every other player uses for this.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const video = container.querySelector("video")!;

    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.95);
    fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(video.volume).toBeCloseTo(0.9);
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(video.volume).toBeCloseTo(0.95);
  });

  it("stops at the ends instead of throwing", async () => {
    // `video.volume = 1.05` is an IndexSizeError, so the clamp is load-bearing
    // rather than tidiness.
    saveVolume(0.95);
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const video = container.querySelector("video")!;

    fireEvent.keyDown(window, { key: "ArrowUp" });
    fireEvent.keyDown(window, { key: "ArrowUp" });
    expect(video.volume).toBe(1);

    for (let i = 0; i < 25; i++) fireEvent.keyDown(window, { key: "ArrowDown" });
    expect(video.volume).toBe(0);
  });

  it("remembers what the arrows did", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "ArrowDown" });

    expect(loadVolume()).toBeCloseTo(0.9);
    expect(container.querySelector("video")!.volume).toBeCloseTo(0.9);
  });

  it("keeps mute and a level as separate states", async () => {
    // Muting then unmuting has to give back the level that was set, which is
    // why zero on the slider is not the same thing as muted.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const video = container.querySelector("video")!;

    fireEvent.change(slider()!, { target: { value: "0.6" } });
    fireEvent.click(screen.getByTitle("Mute (M)"));
    expect(video.muted).toBe(true);
    expect(video.volume).toBeCloseTo(0.6);

    fireEvent.click(screen.getByTitle("Unmute (M)"));
    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.6);
  });

  it("lets the slider speak for the mute button", async () => {
    // Reaching for the slider while muted means wanting to hear something.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    const video = container.querySelector("video")!;

    fireEvent.click(screen.getByTitle("Mute (M)"));
    fireEvent.change(slider()!, { target: { value: "0.5" } });

    expect(video.muted).toBe(false);
    expect(video.volume).toBeCloseTo(0.5);
  });

  it("names the level it is reporting", async () => {
    renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    fireEvent.change(slider()!, { target: { value: "0.25" } });
    expect(slider()).toHaveAttribute("aria-valuetext", "25%");
  });

  it("offers no slider where the level cannot be set", async () => {
    // iOS hands volume to the hardware and treats the property as read-only.
    // A slider that silently does nothing is worse than none at all.
    Object.defineProperty(HTMLMediaElement.prototype, "volume", {
      configurable: true,
      get: () => 1,
      set: () => {},
    });
    try {
      renderLive();
      await waitFor(() => expect(api.startStream).toHaveBeenCalled());

      expect(slider()).toBeNull();
      // Mute still works there — it is the control the platform honours.
      expect(screen.getByTitle("Mute (M)")).toBeInTheDocument();
    } finally {
      delete (HTMLMediaElement.prototype as unknown as Record<string, unknown>).volume;
    }
  });
});
