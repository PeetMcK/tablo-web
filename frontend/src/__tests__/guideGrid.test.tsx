import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { GuideGridView } from "../components/GuideGridView";
import { api } from "../api/tablo";
import type { GridChannel } from "../api/tablo";

/** Two channels whose airings start on the hour, so columns line up. */
function grid(): GridChannel[] {
  const top = new Date();
  top.setMinutes(0, 0, 0);
  const airing = (title: string, hourOffset: number) => ({
    title,
    description: `${title} description`,
    start: new Date(top.getTime() + hourOffset * 3600_000).toISOString(),
    duration: 3600,
    genres: [],
    kind: null,
  });
  return [
    {
      identifier: "ch1", call_sign: "KPAX", major: 8, minor: 1, network: "CBS",
      kind: "ota", display_name: "KPAX", logo_url: null,
      airings: [airing("Survivor", 0), airing("The Late Show", 1)],
    },
    {
      identifier: "ch2", call_sign: "KECI", major: 13, minor: 1, network: "NBC",
      kind: "ota", display_name: "KECI", logo_url: null,
      airings: [airing("Dateline", 0), airing("The Tonight Show", 1)],
    },
  ];
}

function mockStream(channels: GridChannel[]) {
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {
    for (const ch of channels) yield ch;
  });
}

/**
 * The guide's one scroll container.
 *
 * There used to be a lane per row, synced by offset. These helpers assert the
 * replacement invariant: not that the lanes agree, but that there is only one.
 */
function scroller(container: HTMLElement): HTMLElement {
  const found = container.querySelectorAll<HTMLElement>(".overflow-auto");
  expect(found.length).toBe(1);
  return found[0];
}

/** The timeline surface of each channel row — sized, no longer scrollable. */
function timelines(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".h-24"));
}

/** Channel whose listings run `hours` past the top of the current hour. */
function longChannel(hours: number): GridChannel[] {
  const top = new Date();
  top.setMinutes(0, 0, 0);
  return [{
    identifier: "ch1", call_sign: "KPAX", major: 8, minor: 1, network: "CBS",
    kind: "ota", display_name: "KPAX", logo_url: null,
    airings: Array.from({ length: hours }, (_, i) => ({
      title: `Hour ${i}`,
      description: "filler",
      start: new Date(top.getTime() + i * 3600_000).toISOString(),
      duration: 3600,
      genres: [],
      kind: null,
    })),
  }];
}

describe("GuideGridView timeline extent", () => {
  afterEach(() => vi.restoreAllMocks());

  it("runs the clock as far as the listings go", async () => {
    // The header was a fixed six columns while programmes were positioned from
    // their real start time with no cap, so everything past the sixth hour sat
    // under blank space — the times and the content came apart entirely.
    mockStream(longChannel(30));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    const columns = container.querySelectorAll(".font-mono");
    expect(columns.length).toBeGreaterThanOrEqual(30);
  });

  it("names the day when the timeline crosses midnight", async () => {
    // "12:00 AM" alone cannot say which night it belongs to, and this guide runs
    // well past one.
    mockStream(longChannel(30));
    render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    const long = (d: Date) =>
      d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
    const today = new Date();
    today.setMinutes(0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    // Both days are named, not only the one the guide opens on: the date is a
    // band per day rather than a label on that day's first hour column.
    expect(await screen.findByText(long(today))).toBeInTheDocument();
    expect(await screen.findByText(long(tomorrow))).toBeInTheDocument();
  });

  it("sizes each day's band to the hours that day actually has", async () => {
    // The first band is a part-day — the guide opens at the top of the current
    // hour, not at midnight — so a flat 24 would put every later date under
    // the wrong columns. 30 hours from an evening start crosses one midnight.
    const evening = new Date();
    evening.setHours(20, 0, 0, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(evening);
    try {
      mockStream(longChannel(30));
      render(<GuideGridView onPlay={() => {}} />);
      await screen.findByText("Hour 0");

      const today = new Date();
      const label = today.toLocaleDateString([], {
        weekday: "long", month: "long", day: "numeric",
      });
      // 8 PM to midnight is four hours, at 400px each.
      const band = (await screen.findByText(label)).parentElement!;
      expect(band.style.width).toBe(`${4 * 400}px`);
    } finally {
      vi.useRealTimers();
    }
  });

  it("gives every channel the same extent as the clock", async () => {
    // Programmes are absolutely positioned and contribute nothing to width, so
    // a channel whose listings stop early would draw a shorter row than the
    // header unless every row is sized from the guide's full run.
    mockStream([...longChannel(30), {
      identifier: "ch2", call_sign: "KECI", major: 13, minor: 1, network: "NBC",
      kind: "ota", display_name: "KECI", logo_url: null,
      airings: longChannel(2)[0].airings,      // a much shorter listing
    }]);
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    // Both channels carry an "Hour 0", so match all rather than expecting one.
    await screen.findAllByText("Hour 0");

    const rows = timelines(container);
    expect(rows.length).toBe(2);
    const widths = new Set(rows.map(r => r.style.width));
    expect(widths.size).toBe(1);             // both rows span the same distance
  });

  it("still spans a sensible minimum when the guide is nearly empty", async () => {
    mockStream(longChannel(1));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    expect(container.querySelectorAll(".font-mono").length).toBeGreaterThanOrEqual(6);
  });
});

describe("GuideGridView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls as one surface, with nothing left to keep in step", async () => {
    // This replaces a pair of tests that scrolled one lane and asserted the
    // others followed. They passed while the guide still tore: the browser
    // scrolls whichever row the pointer is over with momentum, and the rest
    // were assigned a frame later with none, so a flick left the hovered row
    // tracking the clock and the others trailing it. Synthetic scroll events
    // carry no momentum, so the old tests could never see it.
    //
    // The fix is structural, so the test is too: one scroll container, and no
    // row able to scroll on its own.
    mockStream(grid());
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Survivor");

    // Scoped to inside the grid: the content-filter chips above it are their
    // own horizontal scroller and always were.
    const el = scroller(container);                    // asserts exactly one
    expect(el.querySelectorAll(".overflow-x-auto").length).toBe(0);
  });

  it("freezes the clock and the channel column against that scroll", async () => {
    mockStream(grid());
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Survivor");

    // Sticky rather than outside the scroller, which is what lets one surface
    // carry both axes. Opaque too: these have content moving under them, and a
    // translucent fill would let programmes show through.
    const frozenTop = container.querySelector(".sticky.top-0");
    const frozenLeft = container.querySelectorAll(".sticky.left-0");
    expect(frozenTop).not.toBeNull();
    expect(frozenTop!.className).toContain("bg-surface-sunken");
    expect(frozenLeft.length).toBeGreaterThan(1);      // corner + one per row
    for (const cell of frozenLeft) {
      expect(cell.className).toContain("bg-surface-sunken");
    }
  });
});

describe("jumping the guide to a day and time", () => {
  // Pinned to an evening. Which dayparts are behind the grid depends on the
  // hour it opens at, so a real clock would make these pass or fail by the
  // time of day they happened to run.
  beforeEach(() => {
    const evening = new Date();
    evening.setHours(20, 0, 0, 0);
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(evening);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /** A guide running two full days from the top of this hour. */
  const TWO_DAYS = 48;

  it("scrolls every lane to the hour a cell names", async () => {
    mockStream(longChannel(TWO_DAYS));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    fireEvent.click(screen.getByRole("button", { name: /·/ }));

    // Tomorrow evening: the jump this control exists for, and the one a day
    // picker cannot express — it is seven screens along from here.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);
    const label = new RegExp(
      `${tomorrow.toLocaleDateString([], { weekday: "short" })}.*Prime`, "i");
    fireEvent.click(screen.getByRole("button", { name: label }));

    const top = new Date();
    top.setMinutes(0, 0, 0);
    const prime = new Date(tomorrow);
    prime.setHours(19, 0, 0, 0);
    const expected = ((prime.getTime() - top.getTime()) / 3600_000) * 400;

    expect(scroller(container).scrollLeft).toBe(expected);
  });

  it("brings the guide back to the live edge, with the current programme intact", async () => {
    mockStream(longChannel(TWO_DAYS));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    const el = scroller(container);
    fireEvent.scroll(el, { target: { scrollLeft: 9000 } });
    expect(el.scrollLeft).toBe(9000);

    fireEvent.click(screen.getByRole("button", { name: "NOW" }));

    // Fifteen minutes short of now, so the programme in progress is not
    // clipped at the left edge. The grid starts at the top of the hour, so
    // before a quarter past, that lead falls behind the start and clamps to 0.
    const top = new Date();
    top.setMinutes(0, 0, 0);
    const lead = Date.now() - 15 * 60_000;
    const expected = Math.max(0, ((lead - top.getTime()) / 3600_000) * 400);
    expect(scroller(container).scrollLeft).toBeCloseTo(expected, 0);
  });

  it("refuses a stretch the timeline cannot reach", async () => {
    mockStream(longChannel(TWO_DAYS));
    render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    fireEvent.click(screen.getByRole("button", { name: /·/ }));

    // The grid opens at 8pm here and runs forward, so this morning and this
    // afternoon are behind it. A cell that looked live and did nothing would
    // be worse than one that says it cannot.
    const today = new Date();
    const date = `${today.getMonth() + 1}/${today.getDate()}`;
    for (const part of ["Morning", "Afternoon"]) {
      const cell = screen.getByRole("button", { name: `Today ${date}, ${part}` });
      expect(cell).toBeDisabled();
    }
  });
});

describe("channels you can still tune", () => {
  afterEach(() => vi.restoreAllMocks());

  /** 13.5 THENEST — a real OTA channel the account lists with no EPG data. */
  const nest: GridChannel = {
    identifier: "S999055912_013_05", call_sign: "THENEST", major: 13, minor: 5,
    network: "THENEST", kind: "ota", display_name: "13.5 THENEST",
    logo_url: null, airings: [],
  };

  it("offers a channel with no listings as something to watch", async () => {
    // Without this the row is blank: nothing to click, and no way to reach the
    // channel from the guide at all. Four channels on a real device are in
    // this state.
    const onPlay = vi.fn();
    mockStream([nest]);
    render(<GuideGridView onPlay={onPlay} />);

    const cell = await screen.findByRole("button", { name: /THENEST 13\.5 — no programme information/ });
    expect(cell).toHaveTextContent("Programming Not Available");

    fireEvent.click(cell);
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ identifier: nest.identifier }));
  });

  it("does the same when every listing falls outside the window", async () => {
    // The row is equally blank when the channel HAS airings and none can be
    // drawn - all ended before the grid starts, or all too narrow. Keying off
    // `airings.length` would miss this and leave a dead row.
    const top = new Date();
    top.setMinutes(0, 0, 0);
    mockStream([{
      ...nest,
      airings: [{
        title: "Finished hours ago",
        description: "",
        start: new Date(top.getTime() - 6 * 3600_000).toISOString(),
        duration: 3600,                      // ended long before the grid start
        genres: [],
        kind: null,
      }],
    }]);
    render(<GuideGridView onPlay={() => {}} />);

    expect(await screen.findByText("Programming Not Available")).toBeInTheDocument();
  });

  it("tunes from the channel tile, which is the affordance that survives", async () => {
    // Programme cells are to become show info and recording management, so the
    // tile is the one way to tune that does not change under the user.
    const onPlay = vi.fn();
    mockStream(grid());
    render(<GuideGridView onPlay={onPlay} />);

    fireEvent.click(await screen.findByRole("button", { name: "Watch KPAX 8.1" }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ identifier: "ch1" }));
  });

  it("opens information from a programme cell, and still tunes from the tile", async () => {
    // This is the change: a cell used to tune. The tile is now the tune
    // affordance, which is why it became a real button first.
    const onPlay = vi.fn();
    mockStream(grid());
    render(<GuideGridView onPlay={onPlay} />);

    fireEvent.click(await screen.findByText("Survivor"));
    expect(onPlay).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Watch KPAX 8.1" }));
    expect(onPlay).toHaveBeenCalledWith(expect.objectContaining({ identifier: "ch1" }));
  });

  it("names the channel out loud, since a logo and a number do not", async () => {
    mockStream(grid());
    render(<GuideGridView onPlay={() => {}} />);

    await screen.findByText("Survivor");
    expect(screen.getByRole("button", { name: "Watch KECI 13.1" })).toBeInTheDocument();
  });
});

describe("revealing an airing the search found", () => {
  afterEach(() => vi.restoreAllMocks());

  /** The sheet fetches its own detail; these tests only care that it opened. */
  function mockDetail(title = "Hour 6") {
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title, episode_title: null, season_number: null, episode_number: null,
      description: "filler", start: "2026-09-16T08:00Z", duration: 3600,
      orig_air_date: null, genres: [], rating: null, image_url: null,
      airing_now: false,
      channel: { identifier: "ch1", call_sign: "KPAX", major: 8, minor: 1,
                 network: "CBS", logo_url: null, kind: "ota" },
    });
  }

  /** `jumpTo` for the airing `hoursOut` past the top of this hour. */
  function jump(hoursOut: number, channel = "ch1", nonce = 1) {
    const top = new Date();
    top.setMinutes(0, 0, 0);
    return {
      channel,
      start: new Date(top.getTime() + hoursOut * 3600_000).toISOString(),
      nonce,
    };
  }

  it("opens the show sheet and scrolls the timeline to the airing", async () => {
    mockDetail();
    mockStream(longChannel(24));
    const { container } = render(
      <GuideGridView onPlay={() => {}} jumpTo={jump(6)} />,
    );

    // The sheet is the answer to the click; the scroll is how the guide
    // behind it explains where that answer sits.
    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // 6 hours out, less the 15-minute lead, at 400px an hour: 2300.
    await waitFor(() => expect(scroller(container).scrollLeft).toBe(2300));
  });

  it("opens the sheet even for a channel the grid stream never delivers", async () => {
    // The sheet reads the mirror by (channel, start) and needs nothing from
    // the stream. Making it wait would mean a channel the device has since
    // dropped answers a click with silence.
    mockDetail("Gone Channel");
    mockStream([]);
    render(<GuideGridView onPlay={() => {}} jumpTo={jump(6, "ch-missing")} />);

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("drops a content filter that hides the channel it was sent to", async () => {
    // Otherwise the jump lands on a row that is not rendered: the sheet opens
    // over a guide scrolled to nothing, with no hint that a filter did it.
    mockDetail();
    mockStream(longChannel(24)); // one OTA channel, so "Streaming" empties the grid
    const { rerender, container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    fireEvent.click(screen.getByRole("button", { name: /streaming/i }));
    expect(screen.queryByText("Hour 0")).not.toBeInTheDocument();

    rerender(<GuideGridView onPlay={() => {}} jumpTo={jump(6)} />);

    expect(await screen.findByText("Hour 0")).toBeInTheDocument();
    await waitFor(() => expect(scroller(container).scrollLeft).toBe(2300));
  });

  it("reveals the same airing again when it is activated a second time", async () => {
    // Channel and start are identical between the two clicks, so without the
    // nonce the second is indistinguishable from the first — and closing the
    // sheet would make the result permanently unclickable.
    mockDetail();
    mockStream(longChannel(24));
    const { rerender } = render(
      <GuideGridView onPlay={() => {}} jumpTo={jump(6)} />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    rerender(<GuideGridView onPlay={() => {}} jumpTo={jump(6, "ch1", 2)} />);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("retries the row scroll the browser clamped while channels were still arriving", async () => {
    // The bug this covers, measured in Chrome: the jump fires the moment the
    // row appears, which is the moment the scroller is shortest. With nine of
    // an eventual twenty-eight channels streamed in, a write of 485 clamped
    // to 217 and the guide sat three rows above the show it was sent to.
    //
    // jsdom has no layout, so `scrollTop` there accepts anything and the
    // clamp cannot occur on its own. Standing one in lets the retry be
    // tested; `maxTop` grows the way real content does as rows arrive.
    mockDetail();

    // jsdom has no layout: `scrollTop` accepts anything and `offsetTop` is
    // always 0, so neither the target nor the clamp exists on its own. Both
    // are stood in. `maxTop` is how far the scroller can currently go, and
    // grows the way real content does as rows arrive.
    let maxTop = 100;
    let stored = 0;
    Object.defineProperty(HTMLElement.prototype, "scrollTop", {
      configurable: true,
      get: () => stored,
      set: (v: number) => { stored = Math.min(v, maxTop); },
    });
    Object.defineProperty(HTMLElement.prototype, "offsetTop", {
      configurable: true, get: () => 500,
    });

    // The target channel arrives first and the rest of the guide after, which
    // is the ordering that makes the first attempt the clamped one.
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {
      for (const ch of longChannel(24)) yield ch;
      await gate;
      for (const ch of grid()) yield { ...ch, identifier: `late-${ch.identifier}` };
    });

    const { container } = render(
      <GuideGridView onPlay={() => {}} jumpTo={jump(6)} />,
    );
    await screen.findByText("Hour 0");
    // Asked for 500, got what the short scroller allowed.
    await waitFor(() => expect(scroller(container).scrollTop).toBe(100));

    maxTop = 2000;
    release();

    // More rows arrived, so the guide must finish the journey rather than
    // sit where the clamp left it.
    await waitFor(() => expect(scroller(container).scrollTop).toBe(500));

    Reflect.deleteProperty(HTMLElement.prototype, "offsetTop");
    Reflect.deleteProperty(HTMLElement.prototype, "scrollTop");
  });
});

describe("dragging the guide", () => {
  afterEach(() => vi.restoreAllMocks());

  /** jsdom has no pointer capture. Records who asked for it, and when. */
  function stubCapture() {
    const taken: number[] = [];
    Element.prototype.setPointerCapture = function (id: number) { taken.push(id); };
    Element.prototype.hasPointerCapture = () => false;
    Element.prototype.releasePointerCapture = () => {};
    return taken;
  }

  /**
   * Drag from `target`, `moves` steps of (dx, dy).
   *
   * Pointer events carry a `button` and a `pointerType`; the component checks
   * both, and jsdom supplies neither by default.
   */
  function drag(
    target: HTMLElement,
    opts: { dx?: number; dy?: number; moves?: number },
  ) {
    const { dx = 0, dy = 0, moves = 6 } = opts;
    let x = 400;
    let y = 300;
    const common = { pointerId: 1, pointerType: "mouse", button: 0 };
    fireEvent.pointerDown(target, { ...common, clientX: x, clientY: y });
    for (let i = 0; i < moves; i++) {
      x += dx;
      y += dy;
      fireEvent.pointerMove(target, { ...common, clientX: x, clientY: y });
    }
    fireEvent.pointerUp(target, { ...common, clientX: x, clientY: y });
  }

  function parts(container: HTMLElement) {
    const sc = scroller(container);
    const header = container.querySelector<HTMLElement>("[data-guide-header]")!;
    return {
      sc,
      header,
      dayBand: container.querySelector<HTMLElement>("[data-day-band]")!,
      hourRow: header.querySelector<HTMLElement>(".relative")!,
    };
  }

  it("gears the date band above the hour row", async () => {
    // A band is a day, so a throw across it covers days; the hours stay
    // one-to-one for nudging around an evening.
    stubCapture();
    mockStream(longChannel(24));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");
    const { sc, dayBand, hourRow } = parts(container);

    sc.scrollLeft = 4000;
    drag(hourRow, { dx: -20, moves: 6 });
    const byHours = sc.scrollLeft - 4000;

    sc.scrollLeft = 4000;
    drag(dayBand, { dx: -20, moves: 6 });
    const byDate = sc.scrollLeft - 4000;

    expect(byHours).toBe(120);
    expect(byDate).toBe(120 * 4);
  });

  it("locks a drag to the axis it committed to", async () => {
    // A sloppy sideways drag must not drift the channel rows with it.
    stubCapture();
    mockStream(longChannel(24));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");
    const { sc } = parts(container);
    const surface = sc.firstElementChild as HTMLElement;

    sc.scrollLeft = 2000;
    sc.scrollTop = 200;
    drag(surface, { dx: -20, dy: -6, moves: 6 });
    expect(sc.scrollLeft - 2000).toBe(120);
    expect(sc.scrollTop).toBe(200);

    sc.scrollLeft = 2000;
    sc.scrollTop = 200;
    drag(surface, { dx: -6, dy: -20, moves: 6 });
    expect(sc.scrollLeft).toBe(2000);
    expect(sc.scrollTop - 200).toBe(120);
  });

  it("opens a programme on a click but not at the end of a drag", async () => {
    // The whole reason the threshold exists: the listings are both the thing
    // you grab and the thing you click.
    stubCapture();
    vi.spyOn(api, "airingDetail").mockResolvedValue({
      title: "Hour 3", episode_title: null, season_number: null,
      episode_number: null, description: "filler", start: "2026-09-16T08:00Z",
      duration: 3600, orig_air_date: null, genres: [], rating: null,
      image_url: null, airing_now: false,
      channel: { identifier: "ch1", call_sign: "KPAX", major: 8, minor: 1,
                 network: "CBS", logo_url: null, kind: "ota" },
    });
    mockStream(longChannel(24));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    const cell = await screen.findByText("Hour 3");
    const chip = cell.closest("button")!;
    const { sc } = parts(container);
    sc.scrollLeft = 2000;

    // Panned across it: the guide moves and the sheet stays shut.
    drag(chip, { dx: -20, moves: 6 });
    fireEvent.click(chip);
    expect(sc.scrollLeft).not.toBe(2000);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Pressed and released without travelling: that is a click.
    drag(chip, { dx: 0, moves: 0 });
    fireEvent.click(chip);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("does not take the pointer until a press over the listings becomes a drag", async () => {
    // The regression this covers shipped: capturing on pointerdown made the
    // browser retarget the compatibility mouse events to the capture element,
    // so `click` landed on the scrolled surface rather than the programme
    // button, and no sheet opened at all. jsdom does not model that
    // retargeting, so the test watches the cause instead - capture is taken
    // over the listings only once the gesture is a drag, which is after any
    // click has been ruled out.
    const taken = stubCapture();
    mockStream(longChannel(24));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    const cell = await screen.findByText("Hour 3");
    const chip = cell.closest("button")!;
    const { sc, hourRow } = parts(container);

    // A click: pressed and released without travelling. Nothing captured.
    drag(chip, { dx: 0, moves: 0 });
    expect(taken).toHaveLength(0);

    // A drag over the same chip: captured, because it has to outlive the grid.
    sc.scrollLeft = 2000;
    drag(chip, { dx: -20, moves: 6 });
    expect(taken.length).toBeGreaterThan(0);

    // The header has nothing to click, so it takes the pointer immediately.
    taken.length = 0;
    drag(hourRow, { dx: 0, moves: 0 });
    expect(taken).toHaveLength(1);
  });

  it("ignores a touch, which already pans the guide natively", async () => {
    stubCapture();
    mockStream(longChannel(24));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");
    const { sc, hourRow } = parts(container);

    sc.scrollLeft = 1000;
    fireEvent.pointerDown(hourRow, { pointerId: 2, pointerType: "touch", button: 0, clientX: 400, clientY: 300 });
    fireEvent.pointerMove(hourRow, { pointerId: 2, pointerType: "touch", button: 0, clientX: 200, clientY: 300 });
    fireEvent.pointerUp(hourRow, { pointerId: 2, pointerType: "touch", button: 0, clientX: 200, clientY: 300 });
    expect(sc.scrollLeft).toBe(1000);
  });
});
