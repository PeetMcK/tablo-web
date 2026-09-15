import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  saveResume,
  loadResume,
  clearResume,
  resumeKey,
  hydrateResume,
  flushResume,
  __resetResumeForTests,
} from "../lib/resume";
import { api } from "../api/tablo";

const KEY = resumeKey("recording", 80888);
const GAME = 12615;

describe("resume positions", () => {
  beforeEach(() => {
    __resetResumeForTests();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => __resetResumeForTests());

  it("round-trips a position", () => {
    saveResume(KEY, 4035, GAME);
    expect(loadResume(KEY)).toBe(4035);
  });

  it("returns 0 for something never watched", () => {
    expect(loadResume(resumeKey("recording", 1))).toBe(0);
  });

  it("ignores a position a few seconds in", () => {
    // Resuming at 0:12 is worse than just starting over.
    saveResume(KEY, 12, GAME);
    expect(loadResume(KEY)).toBe(0);
  });

  it("forgets a recording watched to the end", () => {
    saveResume(KEY, 4035, GAME);
    saveResume(KEY, GAME - 5, GAME);
    // Otherwise reopening would drop you on the credits.
    expect(loadResume(KEY)).toBe(0);
  });

  it("keeps entries separate per recording", () => {
    saveResume(resumeKey("recording", 1), 100, GAME);
    saveResume(resumeKey("recording", 2), 200, GAME);
    expect(loadResume(resumeKey("recording", 1))).toBe(100);
    expect(loadResume(resumeKey("recording", 2))).toBe(200);
  });

  it("clears on request", () => {
    saveResume(KEY, 4035, GAME);
    clearResume(KEY);
    expect(loadResume(KEY)).toBe(0);
  });

  it("reads positions back immediately, without waiting on the write", () => {
    // The player asks where to open during render, so a pending PUT must not
    // make the position briefly read as 0.
    vi.spyOn(api, "putResume").mockReturnValue(new Promise(() => {}));
    saveResume(KEY, 4035, GAME);
    expect(loadResume(KEY)).toBe(4035);
  });
});

describe("hydration", () => {
  beforeEach(() => {
    __resetResumeForTests();
    localStorage.clear();
    vi.restoreAllMocks();
  });

  afterEach(() => __resetResumeForTests());

  it("loads stored positions from the server", async () => {
    vi.spyOn(api, "resumeAll").mockResolvedValue({ "recording:80888": 4035 });
    await hydrateResume();
    expect(loadResume(KEY)).toBe(4035);
  });

  it("hands over positions this browser still held, then drops them", async () => {
    localStorage.setItem(
      "tablo:resume",
      JSON.stringify({ "recording:80888": { t: 4035, at: Date.now() } }),
    );
    const importResume = vi.spyOn(api, "importResume").mockResolvedValue({ imported: 1 });
    vi.spyOn(api, "resumeAll").mockResolvedValue({ "recording:80888": 4035 });

    await hydrateResume();

    expect(importResume).toHaveBeenCalledWith({ "recording:80888": 4035 });
    expect(localStorage.getItem("tablo:resume")).toBeNull();
  });

  it("does not let the server response clobber a newer local position", async () => {
    vi.spyOn(api, "putResume").mockResolvedValue({ ok: true });
    vi.spyOn(api, "resumeAll").mockResolvedValue({ "recording:80888": 100 });

    saveResume(KEY, 4035, GAME);
    await hydrateResume();

    expect(loadResume(KEY)).toBe(4035);
  });

  it("starts empty when the server cannot be reached", async () => {
    vi.spyOn(api, "resumeAll").mockRejectedValue(new Error("offline"));
    await hydrateResume();
    expect(loadResume(KEY)).toBe(0);
  });

  it("survives unparseable legacy storage", async () => {
    localStorage.setItem("tablo:resume", "{not json");
    vi.spyOn(api, "resumeAll").mockResolvedValue({});
    await hydrateResume();
    expect(loadResume(KEY)).toBe(0);
    saveResume(KEY, 4035, GAME);
    expect(loadResume(KEY)).toBe(4035);
  });

  it("only hydrates once", async () => {
    const resumeAll = vi.spyOn(api, "resumeAll").mockResolvedValue({});
    await hydrateResume();
    await hydrateResume();
    expect(resumeAll).toHaveBeenCalledTimes(1);
  });
});

describe("flushing", () => {
  beforeEach(() => {
    __resetResumeForTests();
    vi.restoreAllMocks();
  });

  afterEach(() => __resetResumeForTests());

  it("pushes queued positions rather than stranding them on close", async () => {
    const putResume = vi.spyOn(api, "putResume").mockResolvedValue({ ok: true });
    saveResume(KEY, 4035, GAME);
    flushResume();
    await vi.waitFor(() =>
      expect(putResume).toHaveBeenCalledWith("recording", "80888", 4035, GAME),
    );
  });

  it("sends a cleared position as zero", async () => {
    const putResume = vi.spyOn(api, "putResume").mockResolvedValue({ ok: true });
    saveResume(KEY, 4035, GAME);
    clearResume(KEY);
    flushResume();
    await vi.waitFor(() =>
      expect(putResume).toHaveBeenCalledWith("recording", "80888", 0, 0),
    );
  });

  it("sends one write per key, not one per save", async () => {
    const putResume = vi.spyOn(api, "putResume").mockResolvedValue({ ok: true });
    for (let t = 100; t <= 140; t += 10) saveResume(KEY, t, GAME);
    flushResume();
    await vi.waitFor(() => expect(putResume).toHaveBeenCalledTimes(1));
    expect(putResume).toHaveBeenCalledWith("recording", "80888", 140, GAME);
  });
});
