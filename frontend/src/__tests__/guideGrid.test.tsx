import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
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

/** Every horizontally scrollable lane: the time header and one per channel. */
function lanes(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(".overflow-x-auto"))
    .filter(el => el.className.includes("flex-1"));
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

    const [header] = lanes(container);
    const columns = header.querySelectorAll(":scope > div");
    expect(columns.length).toBeGreaterThanOrEqual(30);
  });

  it("names the day when the timeline crosses midnight", async () => {
    // "12:00 AM" alone cannot say which night it belongs to, and this guide runs
    // well past one.
    mockStream(longChannel(30));
    render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    const tomorrow = new Date();
    tomorrow.setMinutes(0, 0, 0);
    tomorrow.setDate(tomorrow.getDate() + 1);
    const label = tomorrow.toLocaleDateString([], { weekday: "short", month: "numeric", day: "numeric" });
    expect(await screen.findByText(label)).toBeInTheDocument();
  });

  it("gives every channel the same scroll extent as the clock", async () => {
    // Programmes are absolutely positioned, so a channel whose listings stop
    // early scrolls a shorter distance than the header and slides out of step
    // with it — the lanes are synced by offset, which assumes a shared width.
    mockStream([...longChannel(30), {
      identifier: "ch2", call_sign: "KECI", major: 13, minor: 1, network: "NBC",
      kind: "ota", display_name: "KECI", logo_url: null,
      airings: longChannel(2)[0].airings,      // a much shorter listing
    }]);
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    // Both channels carry an "Hour 0", so match all rather than expecting one.
    await screen.findAllByText("Hour 0");

    const spacers = container.querySelectorAll<HTMLElement>("[data-timeline-spacer]");
    expect(spacers.length).toBe(2);
    const widths = new Set([...spacers].map(s => s.style.width));
    expect(widths.size).toBe(1);             // both rows span the same distance
  });

  it("still spans a sensible minimum when the guide is nearly empty", async () => {
    mockStream(longChannel(1));
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Hour 0");

    const [header] = lanes(container);
    expect(header.querySelectorAll(":scope > div").length).toBeGreaterThanOrEqual(6);
  });
});

describe("GuideGridView", () => {
  afterEach(() => vi.restoreAllMocks());

  it("scrolls every channel together with the clock", async () => {
    // Each row is its own horizontal scroll container. Without syncing them,
    // dragging one channel slid that row alone: its programmes no longer lined
    // up with the hour headings above or with any other channel, so the grid
    // silently started lying about when things air.
    mockStream(grid());
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Survivor");

    const all = lanes(container);
    expect(all.length).toBeGreaterThan(2);   // header + one per channel

    const [header, ...rows] = all;
    fireEvent.scroll(rows[0], { target: { scrollLeft: 420 } });

    expect(header.scrollLeft).toBe(420);
    for (const row of rows) expect(row.scrollLeft).toBe(420);
  });

  it("scrolls the rows when the clock itself is dragged", async () => {
    mockStream(grid());
    const { container } = render(<GuideGridView onPlay={() => {}} />);
    await screen.findByText("Survivor");

    const [header, ...rows] = lanes(container);
    fireEvent.scroll(header, { target: { scrollLeft: 96 } });

    for (const row of rows) expect(row.scrollLeft).toBe(96);
  });
});
