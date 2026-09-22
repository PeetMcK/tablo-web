/**
 * A control that is always there, and only live when it does something.
 *
 * The rule under test is one clause — the surface has captions and has seen
 * one — and what makes it worth testing is the three different situations it
 * has to cover without knowing they are different: a transcode with no caption
 * source at all, a captioned stream before its first cue, and programming that
 * simply carries none.
 *
 * The button holds its place through all of them. It used to appear only once
 * a cue had been seen, which is a second or so into a captioned stream, and
 * the controls either side shifted as it arrived.
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

/** The button whatever state it is in. */
const ccButton = () => screen.queryByLabelText(/closed captions/i) as HTMLButtonElement | null;
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

  it("is present but dead while the stream has shown no captions", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions()));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    const button = ccButton();
    expect(button).toBeTruthy();
    expect(button!.disabled).toBe(true);
    // Says why, rather than leaving a dimmed icon to be guessed at.
    expect(button!.getAttribute("aria-label")).toBe("No closed captions on this stream");
  });

  it("is dead on a surface that cannot produce captions at all", async () => {
    // No caption source is how the H.264 transcode fallback says it has none.
    wasm.open.mockResolvedValue(stubSurface("running"));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());

    expect(ccButton()!.disabled).toBe(true);
  });

  it("appears once a caption has been seen", async () => {
    wasm.open.mockResolvedValue(stubSurface("running", stubCaptions([HELLO])));
    renderLive();

    expect(await findCc()).toBeTruthy();
  });

  it("comes alive mid-playback, when the first cue arrives a second in", async () => {
    const captions = stubCaptions();
    // Cues are there; the stream has simply not announced itself yet.
    captions.at = () => HELLO;
    captions.allAt = () => [HELLO];
    wasm.open.mockResolvedValue(stubSurface("running", captions));
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(ccButton()!.disabled).toBe(true);

    act(() => captions.announce());

    // Alive, and in the place it has occupied the whole time.
    expect(await findCc()).toBeTruthy();
    expect(ccButton()!.disabled).toBe(false);
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
