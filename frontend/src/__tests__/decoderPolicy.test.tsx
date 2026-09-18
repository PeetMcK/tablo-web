import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import type { Channel, OpenOptions, Program, Recording } from "./decoderPolicySupport";
import { CHANNEL, NEWS_HOUR, REC, stubSurface } from "./decoderPolicySupport";

/**
 * Which decoder plays, and what happens when it cannot.
 *
 * The transcode used to catch every WASM failure. That swapped the picture
 * the device broadcast for a re-encode of it and said nothing, and it hid
 * real faults besides — a path that starves is never seen starving if the
 * player quietly stops using it. These hold the rule that replaced it: one
 * rebuild, then the reason; and the transcode only where there was never a
 * choice, or where the local copy is the thing being played.
 */
const wasm = vi.hoisted(() => ({
  eligible: true,
  opens: [] as unknown[],
  open: vi.fn(),
}));

vi.mock("../lib/wasmlive/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wasmlive/capability")>();
  return {
    ...actual,
    // jsdom has neither WebGL2 nor OffscreenCanvas nor a Chrome user agent, so
    // the real check can only ever say no. Which path is taken is the premise
    // of these tests, not their subject.
    wasmLiveEligible: () => (wasm.eligible
      ? { eligible: true, reason: "" }
      : { eligible: false, reason: "test" }),
  };
});

vi.mock("../lib/wasmlive/open", () => ({ openWasmSurface: wasm.open }));

/** The `onFailure` the player handed to the nth session it opened. */
const failureOf = (nth: number) =>
  (wasm.opens[nth] as OpenOptions).onFailure;

describe("the transcode is not a rescue", () => {
  beforeEach(() => {
    wasm.eligible = true;
    wasm.opens = [];
    wasm.open.mockReset();
    wasm.open.mockImplementation((options: OpenOptions) => {
      wasm.opens.push(options);
      return Promise.resolve(stubSurface());
    });

    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "startStream").mockResolvedValue({
      session_id: "ring-1", proxy_url: "/a", stream_url: "/ring.m3u8", transcoded: false,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  });

  afterEach(() => vi.restoreAllMocks());

  function renderLive(channel: Channel = CHANNEL, program: Program = NEWS_HOUR) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <VideoPlayer source={{ kind: "live", channel, program }} onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  function renderRecording(recording: Recording) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <VideoPlayer source={{ kind: "recording", recording }} onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  /** Every `startStream` that asked for a transcode rather than the ring. */
  const transcodeCalls = () =>
    (api.startStream as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((args) => args[2] === "transcode");

  it("rebuilds a failed live session instead of handing the channel to FFmpeg", async () => {
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalledTimes(1));

    failureOf(0)("decode error");

    await waitFor(() => expect(wasm.open).toHaveBeenCalledTimes(2));
    expect(transcodeCalls()).toHaveLength(0);
    // The ring session that failed holds a tuner and is about to be forgotten.
    expect(api.stopStream).toHaveBeenCalledWith("ring-1");
  });

  it("gives up with the decoder's own reason after the second failure", async () => {
    renderLive();
    await waitFor(() => expect(wasm.open).toHaveBeenCalledTimes(1));

    failureOf(0)("decode error");
    await waitFor(() => expect(wasm.open).toHaveBeenCalledTimes(2));
    failureOf(1)("no first frame");

    // The reason reaches the viewer rather than a quietly worse picture.
    expect(await screen.findByText(/no first frame/)).toBeInTheDocument();
    expect(transcodeCalls()).toHaveLength(0);
    expect(wasm.open).toHaveBeenCalledTimes(2);
  });

  it("still transcodes for a browser that cannot decode MPEG-2 at all", async () => {
    // The rule is "never fall back", not "never transcode". Safari has no
    // WebGL2 pipeline here and no other way to play a broadcast.
    wasm.eligible = false;
    renderLive();

    await waitFor(() => expect(transcodeCalls()).toHaveLength(1));
    expect(wasm.open).not.toHaveBeenCalled();
  });

  it("refuses to play the transcode of a recording it could not decode", async () => {
    // An incidental partial cache is not a copy worth playing — it exists
    // only because something fell back to the transcode once.
    vi.spyOn(api, "watchRecordingVod").mockRejectedValue(new Error("no index"));
    const watch = vi.spyOn(api, "watchRecording");
    renderRecording({ ...REC, cache_state: "partial", cached_seconds: 60 });

    expect(await screen.findByText(/no index/)).toBeInTheDocument();
    expect(watch).not.toHaveBeenCalled();
  });

  it("plays a complete local copy when MPEG-2 will not open", async () => {
    // Complete, local, and it plays when the device is off — which is the
    // entire reason for keeping one.
    vi.spyOn(api, "watchRecordingVod").mockRejectedValue(new Error("no index"));
    const watch = vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: REC.object_id, stream_url: "/t.m3u8", duration: 12615,
      state: "complete", progress: 1, cached_seconds: 12615,
      cached_ranges: [[0, 12615]],
    });
    renderRecording({ ...REC, cache_state: "complete", cached_seconds: 12615 });

    await waitFor(() => expect(watch).toHaveBeenCalledWith(REC.object_id));
  });
});

/**
 * Saying which copy is playing.
 *
 * The local copy is a worse picture than the device's own MPEG-2, and a
 * partial one stops early. Both of those read as the player breaking unless
 * the player says what it is doing.
 */
describe("the player says when it is playing a local copy", () => {
  beforeEach(() => {
    wasm.eligible = true;
    wasm.opens = [];
    wasm.open.mockReset();
    wasm.open.mockImplementation((options: OpenOptions) => {
      wasm.opens.push(options);
      return Promise.resolve(stubSurface());
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  });

  afterEach(() => vi.restoreAllMocks());

  function renderRecording(recording: Recording) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <VideoPlayer source={{ kind: "recording", recording }} onClose={() => {}} />
      </QueryClientProvider>,
    );
  }

  const watch = (state: "complete" | "partial", cached: number) =>
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: REC.object_id, stream_url: "/t.m3u8", duration: REC.duration,
      state, progress: cached / REC.duration, cached_seconds: cached,
      cached_ranges: [[0, cached]],
    });

  it("names the complete copy it is playing", async () => {
    watch("complete", REC.duration);
    renderRecording({ ...REC, pinned: true, cache_state: "complete" });

    expect(await screen.findByText("Offline copy")).toBeInTheDocument();
  });

  it("says how much of a partial copy exists, because it ends there", async () => {
    // The device no longer holds this recording, so a partial copy is all
    // there is — and it stops at 1:00 with no explanation otherwise.
    watch("partial", 60);
    renderRecording({ ...REC, offline_only: true, cache_state: "partial" });

    expect(await screen.findByText(/only 1:00 of/)).toBeInTheDocument();
  });

  it("says nothing when the device's own MPEG-2 is playing", async () => {
    // The good path is the ordinary one. Announcing it on every recording is
    // noise.
    vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "v-1", stream_url: "/v.m3u8",
      duration: REC.duration, segments: 746, growing: false, mode: "vod",
    });
    const { container } = renderRecording(REC);

    await waitFor(() => expect(wasm.open).toHaveBeenCalled());
    expect(container.textContent).not.toContain("Offline copy");
  });
});
