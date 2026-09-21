import { describe, it, expect } from "vitest";
import {
  keepValue, keepFromValue, keepLabel, keepOptions, countLabel,
} from "../lib/keep";

describe("keep limit mapping", () => {
  it("maps device keep to select value", () => {
    expect(keepValue({ rule: "none", count: null })).toBe("auto");
    expect(keepValue({ rule: "all", count: null })).toBe("all");
    expect(keepValue({ rule: "count", count: 5 })).toBe("count:5");
    expect(keepValue(undefined)).toBe("auto");
  });

  it("maps select value back to a write shape", () => {
    expect(keepFromValue("auto")).toEqual({ rule: "none" });
    expect(keepFromValue("all")).toEqual({ rule: "all" });
    expect(keepFromValue("count:10")).toEqual({ rule: "count", count: 10 });
  });

  it("labels: Auto / Last Episode / Last N / All", () => {
    expect(keepLabel({ rule: "none", count: null })).toBe("Auto");
    expect(keepLabel({ rule: "all", count: null })).toBe("All");
    expect(keepLabel({ rule: "count", count: 1 })).toBe("Last ep");
    expect(keepLabel({ rule: "count", count: 5 })).toBe("Last 5");
    expect(countLabel(1)).toBe("Last Episode");
    expect(countLabel(3)).toBe("Last 3 Episodes");
  });

  it("options include presets, plus a custom count when set", () => {
    const std = keepOptions({ rule: "none", count: null }).map((o) => o.value);
    expect(std).toEqual(["auto", "count:1", "count:3", "count:5", "count:10", "count:20", "all"]);
    const custom = keepOptions({ rule: "count", count: 7 }).map((o) => o.value);
    expect(custom).toContain("count:7");
  });
});
