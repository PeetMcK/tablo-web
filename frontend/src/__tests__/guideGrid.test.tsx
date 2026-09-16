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
