import { describe, it, expect } from "vitest";

import { DAY_COLORS, dayColor, dayKey, formatDayHeading } from "../lib/format";

// Local times: the library groups by the day the viewer saw, not by UTC.
const MON = "2026-09-14T18:15:00";
const SUN_LATE = "2026-09-13T23:40:00";

describe("formatDayHeading", () => {
  it("names the weekday and the date", () => {
    expect(formatDayHeading(MON)).toBe("Monday 9/14");
    expect(formatDayHeading(SUN_LATE)).toBe("Sunday 9/13");
  });

  it("says nothing for an unparseable stamp", () => {
    expect(formatDayHeading("not a date")).toBe("");
  });
});

describe("dayKey", () => {
  it("groups by the local calendar day", () => {
    expect(dayKey(MON)).toBe("2026-09-14");
    // A late-evening recording stays on its own evening, not tomorrow.
    expect(dayKey(SUN_LATE)).toBe("2026-09-13");
  });
});

describe("dayColor", () => {
  it("gives a weekday the same colour wherever it appears", () => {
    expect(dayColor(MON)).toBe(DAY_COLORS[1]);
    expect(dayColor("2026-09-21T06:00:00")).toBe(dayColor(MON));
  });

  it("never uses red, which means destructive here", () => {
    expect(DAY_COLORS).toHaveLength(7);
    expect(DAY_COLORS.some((c) => /^#f[0-5][0-9a-f]{2}[0-4]/.test(c))).toBe(false);
  });
});
