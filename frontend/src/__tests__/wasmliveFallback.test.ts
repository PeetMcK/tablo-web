import { describe, it, expect } from "vitest";

import { WASMLIVE_FLAG, chooseLivePath, wasmLiveEligible } from "../lib/wasmlive/capability";
import {
  initialFallbackState, reduceFallback, FIRST_FRAME_DEADLINE_MS,
} from "../lib/wasmlive/fallback";

const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";
const SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.0 Safari/605.1.15";

const capableWindow = (userAgent: string) => ({
  navigator: { userAgent } as Navigator,
  WebGL2RenderingContext: class {},
  OffscreenCanvas: class {},
  AudioWorkletNode: class {},
  WebAssembly: {},
});

const flagOn = { getItem: (k: string) => (k === WASMLIVE_FLAG ? "1" : null) };
const flagOff = { getItem: () => null };
const flagKilled = { getItem: (k: string) => (k === WASMLIVE_FLAG ? "0" : null) };
const storageThrows = {
  getItem: () => { throw new Error("site data blocked"); },
};

describe("wasmLiveEligible", () => {
  it("accepts a flagged-on Chrome with every API present, on an OTA channel", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ota")).toEqual({
      eligible: true, reason: "",
    });
  });

  it("takes a broadcast when nothing has been said either way", () => {
    // Ungated on purpose: the way to find out how this breaks under the real
    // player is to let it take every channel a viewer opens, not only the ones
    // someone thought to switch it on for.
    expect(wasmLiveEligible(capableWindow(CHROME), flagOff, "ota")).toEqual({
      eligible: true, reason: "",
    });
  });

  it("refuses when the flag is explicitly killed", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagKilled, "ota").eligible).toBe(false);
  });

  it("does not throw when site data is blocked", () => {
    // Private mode reads as unset, which is now on. What matters is that a
    // storage exception cannot take the player down with it.
    expect(() => wasmLiveEligible(capableWindow(CHROME), storageThrows, "ota")).not.toThrow();
    expect(wasmLiveEligible(capableWindow(CHROME), storageThrows, "ota").eligible).toBe(true);
  });

  it("refuses OTT channels, which are already H.264", () => {
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, "ott")).toEqual({
      eligible: false, reason: "ott channel",
    });
  });

  it("refuses Safari, which is not the supported target", () => {
    expect(wasmLiveEligible(capableWindow(SAFARI), flagOn, "ota")).toEqual({
      eligible: false, reason: "unsupported browser",
    });
  });

  it("refuses when an API is missing, naming the one that is", () => {
    const win = capableWindow(CHROME) as Record<string, unknown>;
    delete win.OffscreenCanvas;
    expect(wasmLiveEligible(win as never, flagOn, "ota")).toEqual({
      eligible: false, reason: "no OffscreenCanvas",
    });
  });

  it("treats a channel of unknown kind as a broadcast", () => {
    // A guide row arriving without a kind is OTA until proven otherwise, which
    // is what the transcode branch already assumes.
    expect(wasmLiveEligible(capableWindow(CHROME), flagOn, undefined).eligible).toBe(true);
  });
});

describe("chooseLivePath", () => {
  const eligible = { eligible: true, reason: "" };
  const ineligible = { eligible: false, reason: "flag off" };

  it("asks for the ring when the browser is eligible", () => {
    expect(chooseLivePath(eligible, "ota")).toEqual({ mode: "ring", wasm: true });
  });

  it("asks for the transcode for a broadcast otherwise", () => {
    expect(chooseLivePath(ineligible, "ota")).toEqual({ mode: "transcode", wasm: false });
  });

  it("leaves OTT on the direct proxy, which already plays", () => {
    expect(chooseLivePath(ineligible, "ott")).toEqual({ mode: "raw", wasm: false });
  });

  it("treats an unknown kind as a broadcast", () => {
    expect(chooseLivePath(ineligible, undefined)).toEqual({ mode: "transcode", wasm: false });
  });

  it("never falls back to the raw proxy for a broadcast", () => {
    // Raw MPEG-2 is unplayable in the browser: choosing it would hand the
    // viewer a black frame and silence rather than a working stream.
    expect(chooseLivePath(ineligible, "ota").mode).not.toBe("raw");
  });
});

describe("reduceFallback", () => {
  it("gives up when no frame arrives before the deadline", () => {
    const state = reduceFallback(initialFallbackState(0), {
      kind: "tick", atMs: FIRST_FRAME_DEADLINE_MS + 1,
    });
    expect(state.failed).toBe("no first frame");
  });

  it("waits out the deadline rather than failing early", () => {
    const state = reduceFallback(initialFallbackState(0), {
      kind: "tick", atMs: FIRST_FRAME_DEADLINE_MS - 1,
    });
    expect(state.failed).toBeNull();
  });

  it("stops watching the deadline once a frame lands", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 1200 });
    state = reduceFallback(state, { kind: "tick", atMs: 60000 });
    expect(state.failed).toBeNull();
  });

  it("tolerates one starvation", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    expect(state.failed).toBeNull();
  });

  it("gives up on a second starvation inside the window", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    state = reduceFallback(state, { kind: "starved", atMs: 20000 });
    expect(state.failed).toBe("repeated starvation");
  });

  it("forgets starvations that have aged out", () => {
    let state = reduceFallback(initialFallbackState(0), { kind: "first-frame", atMs: 500 });
    state = reduceFallback(state, { kind: "starved", atMs: 4000 });
    state = reduceFallback(state, { kind: "starved", atMs: 90000 });
    expect(state.failed).toBeNull();
  });

  it("gives up immediately on init failure or a decode error", () => {
    expect(reduceFallback(initialFallbackState(0), { kind: "init-failed" }).failed)
      .toBe("init failed");
    expect(reduceFallback(initialFallbackState(0), { kind: "decode-error" }).failed)
      .toBe("decode error");
  });

  it("stays failed once it has failed", () => {
    // One way only: a path that flapped between decoders would be worse than
    // either of them.
    let state = reduceFallback(initialFallbackState(0), { kind: "decode-error" });
    state = reduceFallback(state, { kind: "first-frame", atMs: 900 });
    expect(state.failed).toBe("decode error");
  });
});
