import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChannelGrid } from "../components/ChannelGrid";
import { api } from "../api/tablo";

function mockShell() {
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true, email: "viewer@example.com", devices: [],
    active_sid: null, direct_origin: null,
  });
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {});
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );
}

/**
 * The band between the header's rule and the first thing under it.
 *
 * It was `py-10` — 40px — against 16px below the filter chips, so every page
 * opened with twice as much air above its controls as below them. One number
 * for the top of every page, and it is the one the chips already use.
 */
/*
 * The tabs not moving between pages is `scrollbar-gutter: stable` in
 * index.css, and there is no test for it here: jsdom draws no scrollbars and
 * lays nothing out, so the only honest check is a real browser. Measured in
 * Chrome — the header's tabs at x=134 on Live and Library, x=136 on the Guide
 * before the rule, and 134 on all three after it.
 */

describe("the space under the header", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/live");
    mockShell();
  });
  afterEach(() => vi.restoreAllMocks());

  it("matches the space the chips leave below themselves", async () => {
    renderShell();
    const main = document.querySelector("main")!;

    expect(main.className).toMatch(/\bpt-4\b/);
    expect(main.className).not.toMatch(/\bpy-10\b/);
  });

  it("keeps the room at the foot of the page", async () => {
    // Only the top was wrong. A page still wants air under its last row.
    renderShell();
    expect(document.querySelector("main")!.className).toMatch(/\bpb-10\b/);
  });

  it("drops that foot under the guide on a phone", async () => {
    // The grid runs to both edges there, so a band of page under it would be
    // the one side still framed.
    window.history.replaceState(null, "", "#/grid");
    renderShell();

    const main = document.querySelector("main")!.className;
    expect(main).toMatch(/\bpb-0\b/);
    expect(main).toMatch(/\bsm:pb-10\b/);
  });
});

describe("Live TV's content filter chips", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "#/live");
    mockShell();
  });
  afterEach(() => vi.restoreAllMocks());

  it("wraps, the same way the guide's do", async () => {
    // The same hidden-scrollbar overflow the guide had, with the same result
    // at a narrow window: the last chips simply gone off the edge.
    renderShell();
    const pills = (await screen.findByRole("button", { name: /Movies/ })).parentElement!;

    expect(pills.className).toMatch(/flex-wrap/);
    expect(pills.className).not.toMatch(/overflow-x-auto/);
  });

  it("collapses into the same one control at phone width", async () => {
    // Eight chips do not fit a phone here either, and Live TV is the tab that
    // opens by default — so it collapses the way the guide's do, into the same
    // pill-and-popover rather than a second idea of what this control is.
    renderShell();
    await screen.findByRole("button", { name: /Movies/ });

    const chips = document.querySelector<HTMLElement>("[data-filter-chips]")!;
    const menu = document.querySelector<HTMLElement>("[data-filter-menu]")!;

    expect(chips.className).toMatch(/\bhidden\b/);
    expect(chips.className).toMatch(/\bsm:flex\b/);
    expect(menu.className).toMatch(/\bsm:hidden\b/);
  });

  it("filters from that control too", async () => {
    renderShell();
    await screen.findByRole("button", { name: /Movies/ });
    const menu = within(document.querySelector<HTMLElement>("[data-filter-menu]")!);

    fireEvent.click(menu.getByRole("button"));
    fireEvent.click(menu.getByRole("menuitemradio", { name: /Sports/ }));

    // The trigger names what is in force, which is how the row reports itself
    // once the chips are gone.
    expect(menu.getByRole("button", { name: /Sports/ })).toBeInTheDocument();
  });
});

/** Answer `(max-width: 639px)` — and only that query — with `matches`. */
function stubPhone(matches: boolean) {
  const real = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: matches && query === "(max-width: 639px)",
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => { window.matchMedia = real; };
}

describe("the topbar search at phone width", () => {
  let restoreMedia = () => {};

  beforeEach(() => {
    window.history.replaceState(null, "", "#/live");
    mockShell();
  });
  afterEach(() => { restoreMedia(); vi.restoreAllMocks(); });

  const field = () => screen.getByPlaceholderText(/search programs, channels/i);
  const fieldBox = () => field().parentElement!;

  it("is an icon, not a field, until it is asked for", () => {
    restoreMedia = stubPhone(true);
    renderShell();

    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    // One input, hidden rather than unmounted: its value is the live filter,
    // and unmounting would drop the query every time the row narrowed.
    expect(fieldBox().className).toMatch(/\bhidden\b/);
    expect(screen.getByRole("button", { name: "Guide" })).toBeInTheDocument();
  });

  it("ends the row, with the clock dropped to make the corner", () => {
    // The time is in the phone's own status bar an inch above this, and the
    // corner it frees is where a hand reaches for search.
    restoreMedia = stubPhone(true);
    renderShell();

    const clock = document.querySelector("header .text-right")!.parentElement!;
    expect(clock.className).toMatch(/\bhidden\b/);
    expect(clock.className).not.toMatch(/\bflex\b/);

    const row = document.querySelector("header > div")!;
    const visible = [...row.children].filter(c => !c.className.includes("hidden"));
    expect(visible.at(-1)).toBe(screen.getByRole("button", { name: "Search" }));
  });

  it("takes the row when opened, so the field has somewhere to go", () => {
    restoreMedia = stubPhone(true);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(fieldBox().className).not.toMatch(/\bhidden\b/);
    expect(field()).toHaveFocus();
    // The tabs and the clock stand down — all four do not fit under 640px,
    // which is the whole reason the field collapses in the first place.
    expect(document.querySelector("header nav")!.className).toMatch(/\bhidden\b/);
    expect(screen.getByRole("button", { name: "Close search" })).toBeInTheDocument();
  });

  it("gives the tabs back, and drops the query with them", () => {
    restoreMedia = stubPhone(true);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.change(field(), { target: { value: "broncos" } });
    fireEvent.click(screen.getByRole("button", { name: "Close search" }));

    expect(document.querySelector("header nav")!.className).toMatch(/\bflex\b/);
    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(field()).toHaveValue("");
  });

  it("escape closes it the same way the button does", () => {
    restoreMedia = stubPhone(true);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    fireEvent.keyDown(field(), { key: "Escape" });

    expect(screen.getByRole("button", { name: "Search" })).toBeInTheDocument();
    expect(fieldBox().className).toMatch(/\bhidden\b/);
  });

  it("stays a plain field on anything wider, clock and all", () => {
    restoreMedia = stubPhone(false);
    renderShell();

    expect(screen.queryByRole("button", { name: "Search" })).not.toBeInTheDocument();
    expect(fieldBox().className).not.toMatch(/\bhidden\b/);
    // A tablet has the width for the time, so it keeps it.
    expect(document.querySelector("header .text-right")!.parentElement!.className)
      .toMatch(/\bflex\b/);
  });

  it("gives the icon a finger-sized hit area", () => {
    // 38px drawn, 44 to hit: `.touch-target` is a min-size under
    // `pointer: coarse`, so the mouse layout is untouched. jsdom lays nothing
    // out, so the class is the only honest assertion here — the measurement
    // was taken in Chrome.
    restoreMedia = stubPhone(true);
    renderShell();

    expect(screen.getByRole("button", { name: "Search" }).className)
      .toMatch(/\btouch-target\b/);
    expect(screen.getByRole("button", { name: "Guide" }).className)
      .toMatch(/\btouch-target\b/);
    expect(screen.getByRole("button", { name: "Tablo-Web menu" }).className)
      .toMatch(/\btouch-target\b/);
  });

  it("does not change the height of the bar when it opens", () => {
    // The row used to be as tall as its tallest child: 38px icon closed, 42px
    // field open, so opening search moved the whole page down 4px.
    restoreMedia = stubPhone(true);
    renderShell();
    const row = () => document.querySelector("header > div")!.className;

    expect(row()).toMatch(/h-\[74px\]/);
    expect(row()).not.toMatch(/\bpy-4\b/);

    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(row()).toMatch(/h-\[74px\]/);
  });

  it("keeps the mark off the field once it is open", () => {
    // Expanded, the field is what sits next to the mark — flush against it
    // without a margin of its own.
    restoreMedia = stubPhone(true);
    renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    expect(fieldBox().className).toMatch(/\bml-4\b/);
  });
});
