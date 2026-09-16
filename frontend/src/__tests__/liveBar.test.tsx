import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";

const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};

/** 8:00–9:00 PM, joined at 8:15. */
const HOUR_AGO_QUARTER = 15 * 60;
const startedAt = new Date(Date.now() - HOUR_AGO_QUARTER * 1000);
const NEWS_HOUR: Program = {
  title: "PBS News Hour", description: null,
  start: startedAt.toISOString(), duration: 3600,
};

function clock(d: Date): string {
  return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

/** jsdom has no media stack, so the DVR window has to be described by hand. */
function stubSeekable(end: number) {
  Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
    configurable: true,
    get: () => ({ length: 1, start: () => 0, end: () => end }),
  });
}

function renderLive(program: Program | null = NEWS_HOUR) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer
        source={{ kind: "live", channel: CHANNEL, program }}
        onClose={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** Drive one media `timeupdate`, which is what reads the seekable window. */
async function playAt(container: HTMLElement, seconds: number) {
  const video = container.querySelector("video")!;
  Object.defineProperty(video, "currentTime", { configurable: true, value: seconds });
  await waitFor(() => expect(api.startStream).toHaveBeenCalled());
  fireEvent(video, new Event("timeupdate"));
}

describe("the live bar", () => {
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
    stubSeekable(HOUR_AGO_QUARTER);
  });

  afterEach(() => vi.restoreAllMocks());

  it("spans the airing, so joining a quarter in reads as a quarter in", async () => {
    const { container } = renderLive();
    await playAt(container, HOUR_AGO_QUARTER);

    // Ends of the bar are the programme's own clock times, not the buffer's.
    expect(await screen.findByText(clock(startedAt))).toBeInTheDocument();
    const endsAt = new Date(startedAt.getTime() + 3600_000);
    expect(screen.getByText(clock(endsAt))).toBeInTheDocument();

    // 15 minutes into an hour: the played fill covers a quarter of the bar.
    // Measured with a tolerance, not matched as a string: the anchor is read a
    // few milliseconds after the airing's start is computed, so the percentage
    // lands a hair either side of 25 and only sometimes serialises as "25%".
    await waitFor(() => {
      const widths = Array.from(container.querySelectorAll<HTMLElement>("[style]"))
        .map((el) => parseFloat(el.style.width))
        .filter((w) => !Number.isNaN(w));
      expect(widths.some((w) => Math.abs(w - 25) < 0.5)).toBe(true);
    });
  });

  it("describes the programme being watched, not the one now airing", async () => {
    // Rewound across the top of the hour: the earlier show is what is on
    // screen, so it is what the bar has to measure.
    const now = Date.now();
    const earlier: Program = {
      title: "PBS News Hour", description: null,
      start: new Date(now - 70 * 60_000).toISOString(), duration: 3600,
    };
    const current: Program = {
      title: "Finding Your Roots", description: null,
      start: new Date(now - 10 * 60_000).toISOString(), duration: 1800,
    };
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [earlier, current] });
    stubSeekable(1800);

    const { container } = renderLive(null);
    // 20 minutes behind the live edge, which lands inside the earlier airing.
    await playAt(container, 600);

    expect(await screen.findByText("PBS News Hour")).toBeInTheDocument();
    expect(screen.getByText(clock(new Date(earlier.start)))).toBeInTheDocument();
    expect(screen.queryByText("Finding Your Roots")).toBeNull();
  });

  it("keeps the DVR bar when the channel has no schedule", async () => {
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [] });
    const { container } = renderLive(null);
    await playAt(container, HOUR_AGO_QUARTER);

    // The fallback every OTT channel lands on: elapsed-and-LIVE, as before.
    // "LIVE" appears twice - the edge badge and the end of the bar.
    await waitFor(() => expect(screen.getAllByText("LIVE").length).toBeGreaterThan(1));
    expect(screen.queryByText(clock(startedAt))).toBeNull();
  });

  it("will not seek past the live edge, however wide the bar is", async () => {
    const { container } = renderLive();
    await playAt(container, HOUR_AGO_QUARTER);

    const video = container.querySelector("video")!;
    const seeks: number[] = [];
    Object.defineProperty(video, "currentTime", {
      configurable: true,
      get: () => HOUR_AGO_QUARTER,
      set: (t: number) => seeks.push(t),
    });

    // Forward 30 from the live edge. Three quarters of the bar is programme
    // that has not been broadcast; landing there would stall the player and
    // raise the transcoding overlay.
    fireEvent.click(screen.getByRole("button", { name: /forward 30 seconds/i }));

    await waitFor(() => expect(seeks.length).toBeGreaterThan(0));
    expect(Math.max(...seeks)).toBeLessThanOrEqual(HOUR_AGO_QUARTER);
  });
});
