import { describe, it, expect } from "vitest";

import {
  DAYPARTS, coveredHours, jumpDays, positionLabel,
} from "../lib/guideJump";

const HOUR = 3600_000;

/** Tuesday 15 September 2026, 8pm — the grid's origin in every case below. */
const EIGHT_PM = new Date("2026-09-15T20:00:00").getTime();

/** Every hour from `from`, for `hours` hours: a guide with wall-to-wall listings. */
function allCovered(from: number, hours: number): Set<number> {
  const set = new Set<number>();
  for (let i = 0; i < hours; i++) set.add(from + i * HOUR);
  return set;
}

describe("coveredHours", () => {
  it("marks every hour an airing touches", () => {
    // 8:30–11:30 covers the 8, 9, 10 and 11 o'clock hours.
    const covered = coveredHours([
      { start: new Date(EIGHT_PM + 30 * 60_000).toISOString(), duration: 3 * 3600 },
    ]);
    expect([...covered].sort()).toEqual([
      EIGHT_PM, EIGHT_PM + HOUR, EIGHT_PM + 2 * HOUR, EIGHT_PM + 3 * HOUR,
    ]);
  });

  it("ignores an airing with no usable start or length", () => {
    expect(coveredHours([{ start: "whenever", duration: 1800 }]).size).toBe(0);
    expect(coveredHours([{ start: new Date(EIGHT_PM).toISOString(), duration: 0 }]).size).toBe(0);
  });
});

describe("jumpDays", () => {
  const base = {
    startTime: EIGHT_PM,
    totalHours: 52,                       // through to Thursday midnight
    covered: allCovered(EIGHT_PM, 52),
    now: EIGHT_PM + 45 * 60_000,          // 8:45pm
  };

  it("starts at the day the guide starts on", () => {
    const days = jumpDays(base);
    expect(days[0].label).toBe("Today");
    expect(days[0].cells).toHaveLength(DAYPARTS.length);
    expect(days.length).toBeGreaterThan(1);
  });

  it("marks a daypart that has already finished as past", () => {
    // The grid opens at 8pm, so this morning and afternoon are behind it and
    // the timeline has no way back to them.
    const [today] = jumpDays(base);
    const byId = Object.fromEntries(today.cells.map((c) => [c.part.id, c]));
    expect(byId.morning.state).toBe("past");
    expect(byId.afternoon.state).toBe("past");
  });

  it("marks the daypart containing now as live", () => {
    const [today] = jumpDays(base);
    const prime = today.cells.find((c) => c.part.id === "prime")!;
    expect(prime.state).toBe("live");
    expect(prime.label).toBe("NOW");
  });

  it("offers the rest as listed, labelled with the hour they land on", () => {
    const [, tomorrow] = jumpDays(base);
    const morning = tomorrow.cells.find((c) => c.part.id === "morning")!;
    expect(morning.state).toBe("listed");
    expect(new Date(morning.at).getHours()).toBe(6);
    expect(morning.label).toMatch(/6/);
  });

  it("marks a stretch with no listings as empty, so it cannot be jumped to", () => {
    // Everything covered except tomorrow morning.
    const covered = allCovered(EIGHT_PM, 52);
    const sixAm = new Date(EIGHT_PM);
    sixAm.setDate(sixAm.getDate() + 1);
    sixAm.setHours(6, 0, 0, 0);
    for (let h = 0; h < 6; h++) covered.delete(sixAm.getTime() + h * HOUR);

    const [, tomorrow] = jumpDays({ ...base, covered });
    expect(tomorrow.cells.find((c) => c.part.id === "morning")!.state).toBe("empty");
    expect(tomorrow.cells.find((c) => c.part.id === "prime")!.state).toBe("listed");
  });

  it("runs no further than the guide does", () => {
    const short = jumpDays({ ...base, totalHours: 6, covered: allCovered(EIGHT_PM, 6) });
    expect(short).toHaveLength(1);
  });
});

describe("positionLabel", () => {
  const HOUR_WIDTH = 400;

  it("names the day and the daypart under the scroll position", () => {
    // Two hours along: still tonight's prime time.
    expect(positionLabel(EIGHT_PM, 2 * HOUR_WIDTH, HOUR_WIDTH)).toBe("Today · Prime");
  });

  it("follows the scroll into the next day", () => {
    // 15 hours along is 11am on Wednesday.
    const label = positionLabel(EIGHT_PM, 15 * HOUR_WIDTH, HOUR_WIDTH);
    expect(label).toBe("Wed · Morning");
  });

  it("falls back to the first daypart before the day's morning starts", () => {
    // 5 hours along is 1am — after midnight, before Morning begins.
    expect(positionLabel(EIGHT_PM, 5 * HOUR_WIDTH, HOUR_WIDTH)).toBe("Wed · Late");
  });
});
