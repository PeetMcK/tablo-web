import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, within } from "@testing-library/react";

import { ChannelCard } from "../components/ChannelCard";
import type { GuideChannel } from "../api/tablo";

const NOW = Date.now();

function channel(over: Partial<GuideChannel> = {}): GuideChannel {
  return {
    identifier: "ch1", call_sign: "PBS", major: 7, minor: 1, network: "PBS",
    kind: "ota", display_name: "7.1 PBS", logo_url: null,
    current_program: {
      title: "First Civilizations",
      description: "The Middle East, site of the world's first villages, towns and "
        + "cities, was the birthplace of civilization.",
      start: new Date(NOW - 15 * 60_000).toISOString(),
      duration: 3600,
      genres: ["Documentary"],
      kind: null,
    },
    ...over,
  } as GuideChannel;
}

/**
 * The card is two targets, not one.
 *
 * The channel tile watches, the programme opens the sheet — which is what the
 * guide already does, where the tile tunes and a programme cell opens the
 * sheet. Until now the whole Live TV card tuned, so the artwork, the episode
 * title, the synopsis and the rating were reachable from the guide and
 * nowhere else.
 */
describe("a Live TV card", () => {
  afterEach(() => vi.restoreAllMocks());

  it("watches the channel from its tile", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    render(<ChannelCard channel={channel()} now={NOW} onPlay={onPlay} onInfo={onInfo} />);

    fireEvent.click(screen.getByRole("button", { name: /Watch 7\.1 PBS/ }));

    expect(onPlay).toHaveBeenCalled();
    expect(onInfo).not.toHaveBeenCalled();
  });

  it("opens the programme from its content", () => {
    const onPlay = vi.fn();
    const onInfo = vi.fn();
    render(<ChannelCard channel={channel()} now={NOW} onPlay={onPlay} onInfo={onInfo} />);

    fireEvent.click(screen.getByRole("button", { name: /About First Civilizations/ }));

    expect(onInfo).toHaveBeenCalled();
    expect(onPlay).not.toHaveBeenCalled();
  });

  it("still names the channel for a reader on the half that watches", () => {
    // The tile's visible content is a logo and a number, neither of which
    // announces anything, so the label carries it — as it does in the guide.
    render(<ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const tile = screen.getByRole("button", { name: /Watch 7\.1 PBS/ });
    expect(within(tile).getByText("7.1")).toBeInTheDocument();
  });

  it("offers the sheet for a channel with nothing listed", () => {
    // There is no airing to describe, but the channel is still tunable and the
    // sheet says so — the same sheet the guide's blank rows open.
    const onInfo = vi.fn();
    render(<ChannelCard channel={channel({ current_program: null })} now={NOW}
                        onPlay={() => {}} onInfo={onInfo} />);

    fireEvent.click(screen.getByRole("button", { name: /About 7\.1 PBS/ }));

    expect(onInfo).toHaveBeenCalled();
  });

  it("gives the description room for both of its lines", () => {
    // It was `leading-relaxed h-8`: 19.5px lines in a 32px box, 7px short, so
    // the second line was sliced through the middle on every card that had
    // one. 20px lines in a 40px box is exactly two.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const desc = container.querySelector(".line-clamp-2")!;
    expect(desc.className).toMatch(/\bleading-5\b/);
    expect(desc.className).toMatch(/\bh-10\b/);
    expect(desc.className).not.toMatch(/leading-relaxed|\bh-8\b/);
  });

  it("draws the play triangle on its own centre", () => {
    // The old glyph's box ran x 8..19 — centre 13.5 against the viewBox's 12 —
    // and then carried `translate-x-0.5` on top, so it sat 3.5px right of
    // centre inside a 48px circle. This one is centred on 12.5: half a unit
    // right, which is the optical correction a right-pointing triangle wants
    // and all it wants.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    // Scoped to the puck: the channel logo's own fallback mark is an svg too.
    const puck = container.querySelector(".accent-gradient")!;
    expect(puck.querySelector("path")!.getAttribute("d")).toBe("M7.5 5 17.5 12 7.5 19 Z");
    expect(puck.querySelector("svg")!.getAttribute("class") ?? "")
      .not.toMatch(/translate-x/);
  });
});
