import { describe, it, expect, beforeEach } from "vitest";
import {
  loadSkipForward, loadSkipBack, saveSkipForward, saveSkipBack, clampSkip,
  SKIP_FORWARD_DEFAULT, SKIP_BACK_DEFAULT, SKIP_CONFIG_EVENT,
} from "../lib/skip";

describe("skip config", () => {
  beforeEach(() => localStorage.clear());

  it("defaults to 30 forward / 10 back when unset", () => {
    expect(loadSkipForward()).toBe(SKIP_FORWARD_DEFAULT);
    expect(loadSkipForward()).toBe(30);
    expect(loadSkipBack()).toBe(SKIP_BACK_DEFAULT);
    expect(loadSkipBack()).toBe(10);
  });

  it("round-trips saved values", () => {
    saveSkipForward(45);
    saveSkipBack(5);
    expect(loadSkipForward()).toBe(45);
    expect(loadSkipBack()).toBe(5);
  });

  it("clamps to whole seconds within 1..600, else the default", () => {
    expect(clampSkip(0, SKIP_BACK_DEFAULT)).toBe(10);      // below min → default
    expect(clampSkip(-5, SKIP_FORWARD_DEFAULT)).toBe(30);  // negative → default
    expect(clampSkip(999, SKIP_FORWARD_DEFAULT)).toBe(600);// above max → cap
    expect(clampSkip(Number.NaN, SKIP_FORWARD_DEFAULT)).toBe(30);
    expect(clampSkip(12.5, SKIP_FORWARD_DEFAULT)).toBe(13);// rounded
  });

  it("a garbage stored value reads as the default", () => {
    localStorage.setItem("tablo:skipForward", "not-a-number");
    expect(loadSkipForward()).toBe(30);
  });

  it("save fires the config event for live label refresh", () => {
    let fired = false;
    const on = () => { fired = true; };
    window.addEventListener(SKIP_CONFIG_EVENT, on);
    saveSkipForward(20);
    window.removeEventListener(SKIP_CONFIG_EVENT, on);
    expect(fired).toBe(true);
  });
});
