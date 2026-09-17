import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import { parseRoute, writeRoute } from "../lib/route";

/**
 * Opening a player has to leave a history entry behind it, or Back skips past
 * the whole app. Everything else keeps replacing, so the address stays a
 * stable reference rather than a trail of every tab the viewer touched.
 */
describe("the history a route leaves behind", () => {
  let push: ReturnType<typeof vi.spyOn>;
  let replace: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    window.history.replaceState(null, "", "#/grid");
    push = vi.spyOn(window.history, "pushState");
    replace = vi.spyOn(window.history, "replaceState");
  });
  afterEach(() => vi.restoreAllMocks());

  it("pushes when a player opens, so Back has somewhere to land", () => {
    writeRoute({ tab: "grid", watch: { kind: "live", id: "S79600_007_01" } });
    expect(push).toHaveBeenCalledTimes(1);
    expect(replace).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/grid/ch/S79600_007_01");
  });

  it("replaces when the player closes again", () => {
    // Back itself restores the old entry; a close by Esc or the X should not
    // pile a second copy of the bare tab onto the stack.
    window.history.replaceState(null, "", "#/grid/ch/S79600_007_01");
    push.mockClear();
    writeRoute({ tab: "grid", watch: null });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/grid");
  });

  it("replaces when switching between tabs", () => {
    writeRoute({ tab: "library", watch: null });
    expect(push).not.toHaveBeenCalled();
  });

  it("replaces when one player is swapped for another", () => {
    // Channel surfing should not bury the tab under an entry per channel.
    window.history.replaceState(null, "", "#/grid/ch/A");
    push.mockClear();
    writeRoute({ tab: "grid", watch: { kind: "live", id: "B" } });
    expect(push).not.toHaveBeenCalled();
    expect(window.location.hash).toBe("#/grid/ch/B");
  });

  it("writes nothing at all when the route has not moved", () => {
    window.history.replaceState(null, "", "#/grid/ch/A");
    push.mockClear();
    replace.mockClear();
    writeRoute({ tab: "grid", watch: { kind: "live", id: "A" } });
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });

  it("round-trips what Back lands on", () => {
    // The popped entry is what the listener reads to decide to close.
    expect(parseRoute("#/grid").watch).toBeNull();
    expect(parseRoute("#/library/rec/80888").watch)
      .toEqual({ kind: "recording", id: 80888 });
  });
});
