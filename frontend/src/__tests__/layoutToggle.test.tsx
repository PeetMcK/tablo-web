/**
 * The Library's cards-or-rows switch.
 *
 * Icons rather than a third `OptionMenu`: Group and Sort answer questions with
 * several answers each and need their words, where this is one binary the two
 * icons state outright. Which makes the accessible names carry the whole
 * meaning for anyone not reading the icons — hence these.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { LayoutToggle } from "../components/LayoutToggle";

describe("the layout switch", () => {
  it("offers both layouts and says which is in force", () => {
    render(<LayoutToggle value="cards" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: /Cards/ }))
      .toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /List/ }))
      .toHaveAttribute("aria-pressed", "false");
  });

  it("reports the other layout when it is chosen", () => {
    const onChange = vi.fn();
    render(<LayoutToggle value="cards" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /List/ }));

    expect(onChange).toHaveBeenCalledWith("list");
  });

  it("says nothing when the layout already in force is clicked", () => {
    // A write per click would be a round trip that changes nothing, and the
    // preference is stored server-side.
    const onChange = vi.fn();
    render(<LayoutToggle value="list" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: /List/ }));

    expect(onChange).not.toHaveBeenCalled();
  });

  it("names the group it belongs to", () => {
    render(<LayoutToggle value="list" onChange={() => {}} />);

    expect(screen.getByRole("group", { name: /Layout/i })).toBeInTheDocument();
  });
});
