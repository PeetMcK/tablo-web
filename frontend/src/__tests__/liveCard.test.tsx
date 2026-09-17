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

  it("keeps the plate dark in both themes", () => {
    // `ChannelLogo` draws its own dark plate, because station marks are
    // overwhelmingly white-on-transparent and vanish on a light surface. The
    // tile behind it followed the theme, so light mode put that dark plate
    // inside a near-white one and the two read as a black box floating in a
    // pale box - the nested rounded shape this card's design spent its effort
    // removing. One colour for both, and the pair merges into one square.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const plate = container.querySelector("[data-plate]")!;

    expect(plate.className).toMatch(/\bbg-logo-plate\b/);
    expect(plate.className).not.toMatch(/bg-recess-soft|bg-surface-sunken/);
  });

  it("turns the channel's own plate into the play button", () => {
    // Not a puck laid over the logo and not a badge beside it: the logo
    // crossfades to a bare triangle inside the same square, so the thing you
    // already aim at to get this channel is the thing that plays it. A second
    // rounded shape inside the rounded plate is what the puck was.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const plate = container.querySelector("[data-plate]")!;
    const triangle = plate.querySelector('path[d="M7.5 5 17.5 12 7.5 19 Z"]');

    expect(triangle).not.toBeNull();
    expect(plate.querySelector(".accent-gradient")).toBeNull();
  });

  it("swaps the logo for the triangle on the tile's own hover, not the card's", () => {
    // The mark is how you find the channel. Swapping it the moment a cursor
    // crosses anywhere on the card takes that away while you are still
    // reading the programme beside it.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const plate = container.querySelector("[data-plate]")!;
    const logoWrap = plate.querySelector('[class*="group-hover/tile:opacity-"]')!;
    const triangle = plate.querySelector('svg[class*="group-hover/tile:opacity-100"]')!;

    expect(container.querySelector(".group\\/tile")).not.toBeNull();
    // Dimmed, not removed: a station's mark is mostly colour, and that colour
    // is how the row is scanned, so it stays legible behind the triangle.
    expect(logoWrap.className).toMatch(/group-hover\/tile:opacity-\[0\.35\]/);
    expect(triangle.getAttribute("class")).toMatch(/group-hover\/tile:opacity-100/);
  });

  it("quiets the synopsis rather than blurring it", () => {
    // A clean mark over live text is two things asking to be read in the same
    // square inch. The copy drops contrast and keeps its edges — the words are
    // still words under the mark — and because it fades toward the card's own
    // ground it goes dark in dark and pale in light with no second colour
    // chosen for either.
    render(<ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const body = screen.getByRole("button", { name: /About First Civilizations/ });
    const copy = body.firstElementChild!;

    expect(copy.className).toMatch(/group-hover:opacity-\[0\.35\]/);
    expect(body.innerHTML).not.toMatch(/backdrop-blur/);
    // And the mark itself sits on the half it describes, play glyph nowhere
    // near it.
    expect(body.querySelector(".accent-gradient")).not.toBeNull();
    expect(body.querySelector('.accent-gradient path[d="M7.5 5 17.5 12 7.5 19 Z"]'))
      .toBeNull();
  });

  it("holds the mark up while its own sheet is open", () => {
    // Opening the sheet takes the pointer off the card, so a mark that lived
    // on hover alone would blink out from under the click that opened it and
    // leave the card behind the sheet looking untouched.
    const { container, rerender } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const resting = container.querySelector(".accent-gradient")!.parentElement!;
    expect(resting.className).toMatch(/opacity-0/);

    rerender(<ChannelCard channel={channel()} now={NOW} infoOpen
                          onPlay={() => {}} onInfo={() => {}} />);

    const open = container.querySelector(".accent-gradient")!.parentElement!;
    expect(open.className).toMatch(/opacity-100/);
    expect(open.className).not.toMatch(/opacity-0/);
  });

  it("presses its mark when anywhere in the half is pressed", () => {
    // The mark answers to its own hover, but the press belongs to the whole
    // target: clicking the words and clicking the mark are the same act, so
    // they look the same. Named groups, so neither half answers for the other.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const tile = screen.getByRole("button", { name: /Watch 7\.1 PBS/ });
    const body = screen.getByRole("button", { name: /About First Civilizations/ });

    expect(tile.className).toMatch(/group\/tile/);
    expect(body.className).toMatch(/group\/body/);
    expect(container.querySelector("[data-plate]")!.className)
      .toMatch(/group-active\/tile:scale-95/);
    expect(container.querySelector(".accent-gradient")!.parentElement!.className)
      .toMatch(/group-active\/body:scale-95/);
  });

  it("shows the resolution the device reports", () => {
    // The cloud's channel record has no resolution in it at all; this comes
    // from the device, per channel, and is the only place it is visible.
    render(<ChannelCard channel={channel({ scan: "1080i" })} now={NOW}
                        onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByText("1080i")).toBeInTheDocument();
  });

  it("says nothing where the device reported none", () => {
    // The five OTT channels on a real account are not in the device lineup, so
    // an empty pill would be a permanent blank badge on every one of them.
    render(<ChannelCard channel={channel({ scan: null })} now={NOW}
                        onPlay={() => {}} onInfo={() => {}} />);

    const tile = screen.getByRole("button", { name: /Watch 7\.1 PBS/ });
    expect(tile.querySelector(".rounded-full")).toBeNull();
  });
});

describe("a live card whose programme is being recorded", () => {
  const channelWith = (program: { start: string; duration: number }) =>
    channel({ current_program: { ...channel().current_program!, ...program } });

  const RECORDING_NOW = {
    object_id: 86141, channel_identifier: "ch1",
    start: "2026-09-17T17:30:00Z", duration: 1800,
    recording_started: "2026-09-17T17:29:45Z",
    recorded_seconds: 600, expected_seconds: 1815,
    title: "Scrambled Up",
  };

  it("says so, so you are not left wondering whether to record it again", () => {
    render(
      <ChannelCard
        channel={channelWith({ start: "2026-09-17T17:30:00Z", duration: 1800 })}
        now={Date.parse("2026-09-17T17:39:45Z")}
        recording={RECORDING_NOW}
        onPlay={() => {}}
        onInfo={() => {}}
      />,
    );

    expect(screen.getByLabelText(/recording now/i)).toBeInTheDocument();
  });

  it("draws what was captured, not how far through the clock is", () => {
    // The ordinary bar says where the programme has got to. Once recording,
    // the useful question is how much of it exists - and the tuner here began
    // fifteen seconds early, so coverage starts left of the programme's start.
    const { container } = render(
      <ChannelCard
        channel={channelWith({ start: "2026-09-17T17:30:00Z", duration: 1800 })}
        now={Date.parse("2026-09-17T17:39:45Z")}
        recording={RECORDING_NOW}
        onPlay={() => {}}
        onInfo={() => {}}
      />,
    );

    const fill = container.querySelector<HTMLElement>(".bg-danger");
    expect(fill).not.toBeNull();
    expect(parseFloat(fill!.style.left)).toBe(0);
  });

  it("is left exactly as it was when nothing is recording it", () => {
    const { container } = render(
      <ChannelCard
        channel={channelWith({ start: "2026-09-17T17:30:00Z", duration: 1800 })}
        now={Date.parse("2026-09-17T17:39:45Z")}
        onPlay={() => {}}
        onInfo={() => {}}
      />,
    );

    expect(screen.queryByLabelText(/recording now/i)).toBeNull();
    expect(container.querySelector(".bg-danger")).toBeNull();
  });
});
