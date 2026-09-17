import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

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

  it("names the channel on the control that watches it", () => {
    // The poster says what is on, not whose channel it is, and the number
    // beside it is not announced. The label carries it - as it does in the
    // guide.
    render(<ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByRole("button", { name: /Watch 7\.1 PBS/ })).toBeInTheDocument();
    expect(screen.getByText("7.1")).toBeInTheDocument();
  });

  it("leaves the tile as a picture, not a control", () => {
    // The tile used to be the play button, with the mark crossfading to a
    // triangle on its own hover. With one scrim over the whole card there is
    // nothing to disambiguate, and a poster that behaves like a button invites
    // a click that now belongs to the control sitting on top of it.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const plate = container.querySelector("[data-plate]")!;
    expect(plate.closest("button")).toBeNull();
    expect(plate.querySelector('path[d="M7.5 5 17.5 12 7.5 19 Z"]')).toBeNull();
    expect(container.querySelector(".group\\/tile")).toBeNull();
    expect(container.querySelector(".group\\/body")).toBeNull();
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

  it("holds the mark up while its own sheet is open", () => {
    // Opening the sheet takes the pointer off the card, so a mark that lived
    // on hover alone would blink out from under the click that opened it and
    // leave the card behind the sheet looking untouched.
    const { container, rerender } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const resting = container.querySelector("[data-scrim]")!;
    expect(resting.className).toMatch(/opacity-0/);

    rerender(<ChannelCard channel={channel()} now={NOW} infoOpen
                          onPlay={() => {}} onInfo={() => {}} />);

    const open = container.querySelector("[data-scrim]")!;
    expect(open.className).toMatch(/opacity-100/);
    expect(open.className).not.toMatch(/opacity-0/);
  });

  it("dims the whole card, not one half of it", () => {
    // Two targets needed two treatments that each had to keep their own half
    // readable underneath. One scrim has no such obligation: the card is
    // asking which of two things you want, and what is behind it is context.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const scrim = container.querySelector("[data-scrim]")!;
    expect(scrim.className).toMatch(/\binset-0\b/);
    // Dark in both themes, like the plate it covers - a light veil over a dark
    // tile would invert the card's relationship to its own artwork.
    expect(scrim.className).toMatch(/bg-scrim/);
  });

  it("puts play to the left of info, both on the scrim", () => {
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const scrim = container.querySelector("[data-scrim]")!;
    const buttons = [...scrim.querySelectorAll("button")];

    expect(buttons).toHaveLength(2);
    expect(buttons[0].getAttribute("aria-label")).toMatch(/Watch/);
    expect(buttons[1].getAttribute("aria-label")).toMatch(/About/);
  });

  it("keeps both controls reachable without a pointer", () => {
    // Touch has no hover and neither does the keyboard. The scrim may reveal
    // the controls, but it must not be what creates them, and focusing one has
    // to bring the scrim up or the focus ring sits on something invisible.
    const { container } = render(
      <ChannelCard channel={channel()} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const scrim = container.querySelector("[data-scrim]")!;
    expect(scrim.className).toMatch(/group-focus-within:opacity-100/);

    for (const b of scrim.querySelectorAll("button")) {
      expect(b.hasAttribute("disabled")).toBe(false);
      expect(b.className).toMatch(/focus-visible:ring/);
    }
  });

  it("names the station under the tile", () => {
    // The badge used to carry the scan type. Once the poster took the tile,
    // the thing it displaced was the station's mark - and a row of 28 is
    // scanned by which network it is far more often than by whether it is
    // 1080i. The resolution is still on the sheet.
    render(<ChannelCard channel={channel({ network: "PBS", scan: "1080i" })} now={NOW}
                        onPlay={() => {}} onInfo={() => {}} />);

    expect(screen.getByText("PBS")).toBeInTheDocument();
    expect(screen.queryByText("1080i")).toBeNull();
  });

  it("says nothing where there is no station to name", () => {
    // An empty pill would be a permanent blank badge on every channel that
    // has no network string.
    const { container } = render(
      <ChannelCard channel={channel({ network: "" })} now={NOW}
                   onPlay={() => {}} onInfo={() => {}} />);

    expect(container.querySelector("[data-station]")).toBeNull();
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

/**
 * The tile shows what is on, and falls back to whose channel it is.
 *
 * Roughly one airing in five has no poster - measured on the mirror, 8,747 of
 * 10,655 resolve one, the gap being mostly movies and sports, which are
 * separate record types with no series row. So the logo is the empty state,
 * not a failure path, and a column of cards is expected to be mixed.
 */
describe("the Live card's tile", () => {
  afterEach(() => vi.restoreAllMocks());

  function withPoster(poster_image_id: number | null) {
    const c = channel();
    return { ...c, current_program: { ...c.current_program!, poster_image_id } };
  }

  it("shows the poster for what is airing", () => {
    const { container } = render(
      <ChannelCard channel={withPoster(5007)} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const art = container.querySelector("[data-poster]")!;
    expect(art).not.toBeNull();
    expect(art.getAttribute("src")).toBe("/api/channels/image/5007");
  });

  it("drops the poster's bottom third rather than squashing it", () => {
    // The poster is 240x360 and the tile is square, so something has to go.
    // Taking it off the bottom keeps the title and the faces.
    const { container } = render(
      <ChannelCard channel={withPoster(5007)} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    const art = container.querySelector<HTMLElement>("[data-poster]")!;
    expect(art.style.objectPosition).toBe("50% 0%");
    expect(art.className).toMatch(/object-cover/);
  });

  it("falls back to the channel logo when there is no poster", () => {
    const { container } = render(
      <ChannelCard channel={withPoster(null)} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    expect(container.querySelector("[data-poster]")).toBeNull();
    // The antenna mark carries the call sign when a logo URL is absent.
    expect(screen.getByLabelText("PBS")).toBeInTheDocument();
  });

  it("keeps poster and logo on the same plate, so a mixed column stays even", () => {
    // Both sit on `bg-logo-plate`, dark in both themes as of 01006b5. Without
    // that, a photographic tile and a flat mark would not read as the same
    // object and the column would look ragged.
    const shown = render(
      <ChannelCard channel={withPoster(5007)} now={NOW} onPlay={() => {}} onInfo={() => {}} />);
    const absent = render(
      <ChannelCard channel={withPoster(null)} now={NOW} onPlay={() => {}} onInfo={() => {}} />);

    for (const r of [shown, absent]) {
      expect(r.container.querySelector("[data-plate]")!.className)
        .toMatch(/\bbg-logo-plate\b/);
    }
  });
});
