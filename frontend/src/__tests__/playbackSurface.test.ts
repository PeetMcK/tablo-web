import { describe, it, expect, vi } from "vitest";

import { createHlsSurface } from "../lib/playbackSurface";

function fakeVideo() {
  const listeners = new Map<string, Set<EventListener>>();
  const emit = (type: string) => listeners.get(type)?.forEach((fn) => fn(new Event(type)));

  const video = {
    currentTime: 0,
    paused: true,
    muted: false,
    duration: NaN,
    readyState: 4,
    error: null as MediaError | null,
    buffered: { length: 0 },
    seekable: { length: 1, start: () => 10, end: () => 70 },
    play: vi.fn(async () => { video.paused = false; emit("playing"); }),
    pause: vi.fn(() => { video.paused = true; emit("pause"); }),
    addEventListener: (type: string, fn: EventListener) => {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type)!.add(fn);
    },
    removeEventListener: (type: string, fn: EventListener) => listeners.get(type)?.delete(fn),
  } as unknown as HTMLVideoElement & { paused: boolean };

  return { video, emit };
}

describe("createHlsSurface", () => {
  it("loads the url it is given, once", () => {
    const { video } = fakeVideo();
    const load = vi.fn();
    createHlsSurface(video, load, "/api/transcoded/abc/playlist.m3u8");
    expect(load).toHaveBeenCalledExactlyOnceWith("/api/transcoded/abc/playlist.m3u8");
  });

  it("reports the element's seekable range as a pair", () => {
    const { video } = fakeVideo();
    expect(createHlsSurface(video, vi.fn(), "/x.m3u8").seekable).toEqual([10, 70]);
  });

  it("has no range before the element has one", () => {
    const { video } = fakeVideo();
    (video as unknown as { seekable: unknown }).seekable = { length: 0 };
    expect(createHlsSurface(video, vi.fn(), "/x.m3u8").seekable).toBeNull();
  });

  it("seeks by setting currentTime", () => {
    const { video } = fakeVideo();
    createHlsSurface(video, vi.fn(), "/x.m3u8").seek(42);
    expect(video.currentTime).toBe(42);
  });

  it("plays and pauses through the element", async () => {
    const { video } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    await surface.play();
    expect(surface.paused).toBe(false);
    surface.pause();
    expect(surface.paused).toBe(true);
  });

  it("translates element events into surface events", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onWaiting = vi.fn();
    surface.on("waiting", onWaiting);
    emit("waiting");
    expect(onWaiting).toHaveBeenCalledOnce();
  });

  it("maps pause to the paused surface event, not to its own name", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onPaused = vi.fn();
    surface.on("paused", onPaused);
    emit("pause");
    expect(onPaused).toHaveBeenCalledOnce();
  });

  it("stops delivering after unsubscribe", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onTime = vi.fn();
    surface.on("timeupdate", onTime)();
    emit("timeupdate");
    expect(onTime).not.toHaveBeenCalled();
  });

  it("detaches every listener on destroy", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onTime = vi.fn();
    surface.on("timeupdate", onTime);
    surface.destroy();
    emit("timeupdate");
    expect(onTime).not.toHaveBeenCalled();
  });

  it("has no duration until the element has a finite one", () => {
    const { video } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    expect(surface.duration).toBeNull();
    (video as unknown as { duration: number }).duration = 1800;
    expect(surface.duration).toBe(1800);
  });

  it("owns mute, and reports volume changes", () => {
    const { video, emit } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    const onVolume = vi.fn();
    surface.on("volumechange", onVolume);
    surface.setMuted(true);
    expect(surface.muted).toBe(true);
    emit("volumechange");
    expect(onVolume).toHaveBeenCalledOnce();
  });

  it("describes itself for the debug snapshot", () => {
    const { video } = fakeVideo();
    expect(createHlsSurface(video, vi.fn(), "/x.m3u8").diagnostics()).toMatchObject({
      kind: "hls", readyState: 4,
    });
  });

  it("reports a media error", () => {
    const { video } = fakeVideo();
    const surface = createHlsSurface(video, vi.fn(), "/x.m3u8");
    expect(surface.error).toBeNull();
    (video as unknown as { error: unknown }).error = { code: 3 };
    expect(surface.error).toContain("3");
  });
});
