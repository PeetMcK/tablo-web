import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Mock } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { VideoPlayer } from "../components/VideoPlayer";
import { api } from "../api/tablo";
import { CHANNEL, NEWS_HOUR, REC, stubSurface } from "./decoderPolicySupport";

/**
 * Reaching the rest of a show from the player.
 *
 * The show's name in the corner of the transport used to be
 * `pointer-events-none`, so a click on it fell through to the picture — and the
 * left two fifths of the picture is Back 10s. Reaching for the title rewound
 * the programme, which is the opposite of what pointing at a name means.
 */

// jsdom has no Media Source Extensions, so the HLS path reports "HLS not
// supported in this browser" and the player shows an error — which hides the
// card, whatever the click did. Which decoder plays is not the subject here, so
// the WASM path is taken and given a surface that simply works.
const wasm = vi.hoisted(() => ({ open: vi.fn() }));

vi.mock("../lib/wasmlive/capability", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/wasmlive/capability")>();
  return {
    ...actual,
    wasmLiveEligible: () => ({ eligible: true, reason: "" }),
  };
});

vi.mock("../lib/wasmlive/open", () => ({ openWasmSurface: wasm.open }));

const OTHER = {
  ...REC,
  object_id: 90001,
  identifier: 90001,
  title: "NFL Football",
  subtitle: "Bears at Packers",
};

function renderRecording() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <VideoPlayer source={{ kind: "recording", recording: REC }} onClose={() => {}} />
    </QueryClientProvider>,
  );
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

/** The name in the corner, however it happens to be rendered. */
const name = () => screen.getByText(REC.title!);

describe("the show's name in the player", () => {
  // Typed through the mocks rather than the interface: `stubSurface` returns a
  // `PlaybackSurface`, whose members are plain functions as far as the type is
  // concerned, and these tests need to clear and inspect them.
  let surface: {
    [K in keyof ReturnType<typeof stubSurface>]: ReturnType<typeof stubSurface>[K];
  } & { seek: Mock; pause: Mock; play: Mock };

  beforeEach(() => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    vi.spyOn(api, "watchRecording").mockResolvedValue({
      object_id: REC.object_id, stream_url: "/api/recordings/cache/80888/playlist.m3u8",
      state: "complete", progress: 1, duration: 12615, cached_seconds: 12615,
      cached_ranges: [[0, 12615]],
    });
    surface = stubSurface() as typeof surface;
    wasm.open.mockImplementation(async () => surface);
    vi.spyOn(api, "watchRecordingVod").mockResolvedValue({
      object_id: REC.object_id, session_id: "vod-1", mode: "vod",
      stream_url: "/api/vod/vod-1/playlist.m3u8",
      duration: 12615, segments: 8400, growing: false,
    });
    vi.spyOn(api, "stopStream").mockResolvedValue({ ok: true });
    vi.spyOn(api, "recordingStatus").mockResolvedValue({
      object_id: REC.object_id, state: "complete", progress: 1, duration: 12615,
      cached_seconds: 12615, cached_ranges: [[0, 12615]], encoding: null,
      preview: "ready", error: null,
    });
    vi.spyOn(api, "recordings").mockResolvedValue({
      recordings: [REC, OTHER], returned: 2, total: 2, offline_only: 0,
    });
    vi.spyOn(api, "recordingSeries").mockResolvedValue({
      series_path: null, title: null, cover_image: null,
    });
    vi.spyOn(api, "channelAirings").mockResolvedValue({ airings: [NEWS_HOUR] });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
  });

  afterEach(() => { vi.restoreAllMocks(); wasm.open.mockReset(); });

  it("is something you can click, on a recording", async () => {
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());
  });

  it("opens the rest of the show rather than rewinding ten seconds", async () => {
    // The whole point. A click here used to reach the surface behind it.
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());

    fireEvent.click(name().closest("button")!);

    expect(await screen.findByRole("dialog", { name: "The rest of this show" }))
      .toBeTruthy();
  });

  it("does not seek the picture behind it", async () => {
    // The bug, stated as what must not happen: the name sits in the left two
    // fifths of the frame, and a click that reaches the frame there is Back
    // 10s. Nothing may move the playhead.
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());
    surface.seek.mockClear();

    fireEvent.click(name().closest("button")!);

    await screen.findByRole("dialog", { name: "The rest of this show" });
    expect(surface.seek).not.toHaveBeenCalled();
  });

  it("holds the picture while the list is up", async () => {
    // A list to read with the programme playing on underneath is a few seconds
    // missed by whoever comes back to it.
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());
    surface.pause.mockClear();

    fireEvent.click(name().closest("button")!);

    await screen.findByRole("dialog", { name: "The rest of this show" });
    expect(surface.pause).toHaveBeenCalled();
  });

  it("gives the picture back when the list is dismissed", async () => {
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());
    fireEvent.click(name().closest("button")!);
    await screen.findByRole("dialog", { name: "The rest of this show" });
    surface.play.mockClear();

    fireEvent.click(screen.getByLabelText("Keep watching"));

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "The rest of this show" })).toBeNull();
    });
    expect(surface.play).toHaveBeenCalled();
  });

  it("closes on Escape without closing the player", async () => {
    renderRecording();
    await waitFor(() => expect(name().closest("button")).not.toBeNull());
    fireEvent.click(name().closest("button")!);
    await screen.findByRole("dialog", { name: "The rest of this show" });

    fireEvent.keyDown(window, { key: "Escape" });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "The rest of this show" })).toBeNull();
    });
    // Still watching: the player is where it was.
    expect(screen.getByText(REC.title!)).toBeTruthy();
  });

  it("is not a button on a live channel, which has no series", async () => {
    renderLive();
    await screen.findByText(CHANNEL.display_name);
    expect(screen.getByText(CHANNEL.display_name).closest("button")).toBeNull();
  });
});
