import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
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

const stage = (c: HTMLElement) => c.firstElementChild as HTMLElement;
const transport = (c: HTMLElement) =>
  c.querySelector<HTMLElement>(".flex.flex-col.gap-3.pointer-events-auto")!;

/**
 * The zones are fractions of the frame, and jsdom lays nothing out — so the
 * frame has to be described before a pointer position means anything.
 */
function moveAcross(container: HTMLElement, fraction: number) {
  const el = stage(container);
  el.getBoundingClientRect = () => ({
    left: 0, width: 1000, top: 0, height: 500, bottom: 500, right: 1000,
    x: 0, y: 0, toJSON: () => "",
  }) as DOMRect;
  fireEvent.mouseMove(el, { clientX: 1000 * fraction, clientY: 100 });
}

/**
 * Whether a button is wearing the hover it was lent.
 *
 * Exact class membership, not a substring: every one of these buttons carries
 * `hover:bg-fill` already, so `includes("bg-fill")` is true of all of them
 * always and asserts nothing.
 */
const lit = (container: HTMLElement, title: string) =>
  [...container.querySelector(`[title^="${title}"]`)!.classList].includes("bg-fill");

describe("the invisible click zones", () => {
  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "abc", proxy_url: "/a", stream_url: "/b", transcoded: true,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "transcodeStatus").mockResolvedValue({
      status: "active", encoded_seconds: 900,
    });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    Object.defineProperty(HTMLMediaElement.prototype, "seekable", {
      configurable: true,
      get: () => ({ length: 1, start: () => 0, end: () => 900 }),
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it("lights the button a click underneath would press", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());

    moveAcross(container, 0.2);                       // left two fifths
    expect(lit(container, "Back 10s")).toBe(true);
    expect(lit(container, "Pause")).toBe(false);

    moveAcross(container, 0.5);                       // middle fifth
    expect(lit(container, "Pause")).toBe(true);
    expect(lit(container, "Back 10s")).toBe(false);

    moveAcross(container, 0.8);                       // right two fifths
    expect(lit(container, "Forward 30s")).toBe(true);
    expect(lit(container, "Pause")).toBe(false);
  });

  it("lets go when the pointer leaves the frame", async () => {
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    moveAcross(container, 0.2);
    expect(lit(container, "Back 10s")).toBe(true);

    fireEvent.mouseLeave(stage(container));
    expect(lit(container, "Back 10s")).toBe(false);
  });

  it("lets go when the pointer reaches the controls themselves", async () => {
    // Two lit buttons would misreport what a click is about to do.
    const { container } = renderLive();
    await waitFor(() => expect(api.startStream).toHaveBeenCalled());
    moveAcross(container, 0.5);
    expect(lit(container, "Pause")).toBe(true);

    fireEvent.mouseOver(transport(container));
    expect(lit(container, "Pause")).toBe(false);
  });
});
