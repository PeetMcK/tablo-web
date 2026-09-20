import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, Program } from "../api/tablo";

const CHANNEL: Channel = {
  identifier: "S84522_007_02", call_sign: "K08PRD2", major: 7, minor: 2,
  network: "WORLD", kind: "ota", display_name: "7.2 K08PRD2",
};
const NEWS: Program = {
  title: "PBS News Hour", description: null,
  start: new Date(Date.now() - 15 * 60 * 1000).toISOString(), duration: 3600,
};

function renderLive() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer source={{ kind: "live", channel: CHANNEL, program: NEWS }} onClose={() => {}} />
    </QueryClientProvider>,
  );
}

describe("pause when the headphones come out", () => {
  let deviceChange: (() => void) | null;
  let outputs: number;
  const origPaused = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "paused");

  beforeEach(() => {
    deviceChange = null;
    outputs = 2; // headphones + built-in, say
    (navigator as unknown as Record<string, unknown>).mediaDevices = {
      enumerateDevices: vi.fn(async () =>
        Array.from({ length: outputs }, () => ({ kind: "audiooutput" }))),
      addEventListener: (type: string, cb: () => void) => {
        if (type === "devicechange") deviceChange = cb;
      },
      removeEventListener: () => {},
    };
    // The surface is "playing" in jsdom (paused is true there by default).
    Object.defineProperty(HTMLMediaElement.prototype, "paused", {
      configurable: true, get: () => false,
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/api/hls/abc/playlist.m3u8",
      stream_url: "/api/transcoded/abc/playlist.m3u8", transcoded: true,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "transcodeStatus").mockResolvedValue({ status: "active", encoded_seconds: 900 });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete (navigator as unknown as Record<string, unknown>).mediaDevices;
    if (origPaused) {
      Object.defineProperty(HTMLMediaElement.prototype, "paused", origPaused);
    }
  });

  it("pauses when an audio output device disappears", async () => {
    renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    await waitFor(() => expect(deviceChange).toBeTypeOf("function"));

    const pause = HTMLMediaElement.prototype.pause as unknown as ReturnType<typeof vi.fn>;
    pause.mockClear();

    // An output goes away (headphones removed), then the event fires.
    outputs = 1;
    deviceChange!();

    await waitFor(() => expect(pause).toHaveBeenCalled());
  });

  it("does not pause when a device is added", async () => {
    renderLive();
    await waitFor(() => expect(deviceChange).toBeTypeOf("function"));
    const pause = HTMLMediaElement.prototype.pause as unknown as ReturnType<typeof vi.fn>;
    pause.mockClear();

    outputs = 3; // a device appeared
    deviceChange!();
    // Give the async handler a tick; it must not pause.
    await new Promise((r) => setTimeout(r, 10));
    expect(pause).not.toHaveBeenCalled();
  });
});
