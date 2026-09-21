/**
 * A control that is only there when it does something.
 *
 * The rule under test is one clause — the surface has captions and has seen
 * one — and what makes it worth testing is the three different situations it
 * has to cover without knowing they are different: a transcode with no caption
 * source at all, a captioned stream before its first cue, and programming that
 * simply carries none.
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

const ccButton = () => screen.queryByLabelText(/closed captions/i);
const findCc = () => screen.findByLabelText(/closed captions/i);

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

  it("is absent while the stream has shown no captions", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions()));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    expect(ccButton()).toBeNull();
  });

  it("is absent on a surface that cannot produce captions at all", async () => {
    // No caption source is how the H.264 transcode fallback says it has none.
    wasm.open.mockResolvedValue(stubSurface("running"));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    expect(ccButton()).toBeNull();
  });

  it("appears once a caption has been seen", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    expect(await findCc()).toBeTruthy();
  });

  it("appears mid-playback, when the first cue arrives a second in", async () => {
    const captions = stubCaptions();
    // Cues are there; the stream has simply not announced itself yet.
    captions.at = () => HELLO;
    wasm.open.mockResolvedValue(stubSurface("running", captions));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(ccButton()).toBeNull();

    act(() => captions.announce());

    expect(await findCc()).toBeTruthy();
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
