/**
 * One box, two jobs, and a switch that means something.
 *
 * Strict: the mode decides the behaviour and nothing leaks across. The topbar
 * text used to filter the Live list locally AND open the dropdown, which made
 * a two-position switch whose positions both did some filtering. Search mode
 * gives that up on purpose.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { ChannelGrid } from "../components/ChannelGrid";
import { api, type GuideChannel } from "../api/tablo";

function channel(id: string, call: string, network: string, name: string): GuideChannel {
  return {
    identifier: id, call_sign: call, major: 0, minor: 0, network,
    display_name: name, kind: "ota", logo_url: null, current_program: null,
  } as unknown as GuideChannel;
}

/**
 * A card with nothing airing says "Watching <display name>", and that line is
 * the only place a channel's full name appears once — the header shows the
 * call sign, which the filter also matches on.
 */
const MONTANA = "Watching Montana PBS";
const FOX = "Watching ABC Fox";

function mockShell() {
  vi.spyOn(api, "status").mockResolvedValue({
    authenticated: true, email: "viewer@example.com", devices: [],
    active_sid: null, direct_origin: null,
  });
  // One channel per yield, not an array: that is what `useGuideStream`
  // iterates, and an array arrives as a single row with no identifier.
  vi.spyOn(api, "guideStream").mockImplementation(async function* () {
    yield channel("A", "KUFM", "PBS", "Montana PBS");
    yield channel("B", "KTMF", "FOX", "ABC Fox");
  });
  vi.spyOn(api, "guideGridStream").mockImplementation(async function* () {});
  vi.spyOn(api, "prefs").mockResolvedValue({});
}

function renderShell() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <ChannelGrid onLogout={() => {}} />
    </QueryClientProvider>,
  );
}

/** The one text box in the topbar, whatever it is currently called. */
function box(): HTMLInputElement {
  return document.querySelector<HTMLInputElement>("header input[type=text]")!;
}

describe("the topbar box's two jobs", () => {
  beforeEach(() => {
    localStorage.clear();
    window.history.replaceState(null, "", "#/live");
    mockShell();
  });
  afterEach(() => vi.restoreAllMocks());

  it("opens on the filter", async () => {
    renderShell();
    expect(await screen.findByRole("radio", { name: "Filter this page" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("names itself after the page it is narrowing", async () => {
    renderShell();
    await screen.findByRole("radio", { name: "Filter this page" });

    expect(box()).toHaveAttribute("placeholder", "Filter channels...");
  });

  it("narrows the Live list and shows no dropdown", async () => {
    renderShell();
    await screen.findByText(MONTANA);

    fireEvent.change(box(), { target: { value: "kufm" } });

    await waitFor(() => expect(screen.queryByText(FOX)).toBeNull());
    expect(screen.getByText(MONTANA)).toBeInTheDocument();
    expect(screen.queryByRole("listbox", { name: "Search suggestions" })).toBeNull();
  });

  it("leaves the Live list alone in search mode", async () => {
    // The cost of a switch that means something: search searches, and the page
    // under it is the page you were already looking at.
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    renderShell();
    await screen.findByText(MONTANA);

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));
    fireEvent.change(box(), { target: { value: "kufm" } });

    expect(await screen.findByText(FOX)).toBeInTheDocument();
    expect(box()).toHaveAttribute("placeholder", "Search programs, channels...");
  });

  it("reinterprets what is already typed when the switch is flipped", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    renderShell();
    await screen.findByText(MONTANA);

    fireEvent.change(box(), { target: { value: "kufm" } });
    await waitFor(() => expect(screen.queryByText(FOX)).toBeNull());

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));

    expect(box()).toHaveValue("kufm");
    expect(await screen.findByText(FOX)).toBeInTheDocument();
  });

  it("gives the whole page back on Escape while filtering", async () => {
    // What the Library's own filter did, kept: filtering has no dropdown to
    // dismiss, and the text is the only thing standing between the viewer and
    // everything on the page.
    renderShell();
    await screen.findByText(MONTANA);
    fireEvent.change(box(), { target: { value: "kufm" } });
    await waitFor(() => expect(screen.queryByText(FOX)).toBeNull());

    fireEvent.keyDown(box(), { key: "Escape" });

    expect(box()).toHaveValue("");
    expect(await screen.findByText(FOX)).toBeInTheDocument();
  });

  it("leaves the URL alone while filtering", async () => {
    // Unlike the search, which names a results page anyone can link to. A
    // filter narrows a page that is already open.
    renderShell();
    await screen.findByText(MONTANA);
    const before = window.location.hash;

    fireEvent.change(box(), { target: { value: "kufm" } });

    expect(window.location.hash).toBe(before);
  });

  it("greys the funnel on the Guide, and gives it back on the way out", async () => {
    renderShell();
    await screen.findByRole("radio", { name: "Filter this page" });

    fireEvent.click(screen.getByRole("button", { name: "Guide" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Filter this page" })).toBeDisabled());

    fireEvent.click(screen.getByRole("button", { name: "Live" }));
    await waitFor(() =>
      expect(screen.getByRole("radio", { name: "Filter this page" }))
        .toHaveAttribute("aria-checked", "true"));
  });

  it("remembers the mode and the text across a reload", async () => {
    vi.spyOn(api, "search").mockResolvedValue({ query: "kufm", groups: [] } as never);
    const first = renderShell();
    await screen.findByText(MONTANA);

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));
    fireEvent.change(box(), { target: { value: "kufm" } });
    await waitFor(() =>
      expect(localStorage.getItem("tablo:topbar.query")).toBe("kufm"));
    first.unmount();

    renderShell();

    expect(await screen.findByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "true");
    expect(box()).toHaveValue("kufm");
  });
});
