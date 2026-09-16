import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
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
});
