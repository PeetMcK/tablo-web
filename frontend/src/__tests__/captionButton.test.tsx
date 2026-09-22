/**
 * A control that is always there, and live until the stream proves it is not.
 *
 * Captions announce themselves a second or two into speech, so a button that
 * waits for the first cue is dead exactly when a viewer reaches for it - and
 * it used to be absent until then, which moved the controls either side as it
 * appeared. So it starts live: pressing it before the first cue turns
 * captions on, and they show when they arrive.
 *
 * Greying out is the slow path. Only after `CAPTION_SILENCE_MS` of a stream
 * saying nothing does the button give up and say so, by which time "no
 * captions" is the truth rather than a guess. A programme opening on a title
 * card or a silent establishing shot must not trip it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import { CHANNEL, NEWS_HOUR, stubCaptions, stubSurface } from "./decoderPolicySupport";
import type { CaptionCue } from "../lib/captions";

const wasm = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../lib/wasmlive/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wasmlive/capability")>();
  // jsdom has no WebGL2, no OffscreenCanvas and no Chrome user agent, so the
  // real check can only ever say no. Which path plays is the premise here,
  // not the subject.
  return { ...actual, wasmLiveEligible: () => ({ eligible: true, reason: "" }) };
});

vi.mock("../lib/wasmlive/open", () => ({ openWasmSurface: wasm.open }));

const HELLO: CaptionCue = { startSeconds: 0, endSeconds: 600, text: "HELLO" };

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

/** The button whatever state it is in - it renames itself when it gives up. */
const ccButton = () =>
  screen.queryByLabelText(/closed captions|CC data/i) as HTMLButtonElement | null;
/** The button once it actually does something - the label says which. */
const findCc = () => screen.findByLabelText(/(Show|Hide) closed captions/i);

describe("the CC button", () => {
  beforeEach(() => {
    localStorage.clear();
    wasm.open.mockReset();
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "ring-1", proxy_url: "/a", stream_url: "/ring.m3u8", transcoded: false,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  });

  afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

  it("is live before a single caption has been seen", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions()));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    // The stream has said nothing yet, and nothing is not the same as none.
    const button = ccButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(false);
  });

  it("gives up only after the stream has stayed silent", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      wasm.open.mockResolvedValue(stubSurface("running", stubCaptions()));
      renderLive();
      await waitFor(() => expect(wasm.open).toHaveBeenCalled());
      expect(ccButton()!.disabled).toBe(false);

      await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });

      const button = ccButton()!;
      expect(button.disabled).toBe(true);
      // Says why, rather than leaving a dimmed icon to be guessed at.
      expect(button.getAttribute("aria-label")).toBe("No CC data on this stream");
    } finally {
      vi.useRealTimers();
    }
  });

  it("stays live when a caption arrives during the wait", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const captions = stubCaptions();
      captions.at = () => HELLO;
      captions.allAt = () => [HELLO];
      wasm.open.mockResolvedValue(stubSurface("running", captions));
      renderLive();
      await waitFor(() => expect(wasm.open).toHaveBeenCalled());

      // A title card's worth of silence, then speech.
      await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
      act(() => captions.announce());
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });

      expect(ccButton()!.disabled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives up on a surface that cannot produce captions at all", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      // No caption source is how the H.264 transcode fallback says it has none.
      wasm.open.mockResolvedValue(stubSurface("running"));
      renderLive();
      await waitFor(() => expect(wasm.open).toHaveBeenCalled());

      await act(async () => { await vi.advanceTimersByTimeAsync(95_000); });
      expect(ccButton()!.disabled).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("appears once a caption has been seen", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    expect(await findCc()).toBeTruthy();
  });

  it("shows captions switched on before the first cue arrived", async () => {
    const captions = stubCaptions();
    // Cues are there; the stream has simply not announced itself yet, which
    // is the moment a viewer reaching for CC used to get a dead control.
    captions.at = () => HELLO;
    captions.allAt = () => [HELLO];
    wasm.open.mockResolvedValue(stubSurface("running", captions));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    fireEvent.click(ccButton()!);
    act(() => captions.announce());

    expect(await screen.findByText("HELLO")).toBeTruthy();
  });

  it("toggles captions on and off", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    fireEvent.click(await findCc());
    expect(await screen.findByText("HELLO")).toBeTruthy();

    fireEvent.click(await findCc());
    await waitFor(() => expect(screen.queryByText("HELLO")).toBeNull());
  });

  it("remembers the choice", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    fireEvent.click(await findCc());
    await waitFor(() => expect(localStorage.getItem("tablo.cc")).toBe("1"));
  });

  it("starts on when it was left on", async () => {
    localStorage.setItem("tablo.cc", "1");
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    expect(await screen.findByText("HELLO")).toBeTruthy();
  });

  it("toggles on C", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();
    await findCc();

    fireEvent.keyDown(window, { key: "c" });
    expect(await screen.findByText("HELLO")).toBeTruthy();
  });
});
