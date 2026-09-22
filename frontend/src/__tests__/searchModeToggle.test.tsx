/**
 * The two-way switch in the topbar field's left cap.
 *
 * A glyph shows state, not the act: the funnel means "this box is narrowing
 * the page", so the act lives in the accessible name and the tooltip.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { SearchModeToggle } from "../components/SearchModeToggle";

describe("the filter/search switch", () => {
  it("offers both jobs, and says which one is on", () => {
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);

    expect(screen.getByRole("radio", { name: "Filter this page" }))
      .toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("leaves the spyglass where the single icon always was", () => {
    // The box has worn a spyglass in this spot since it was only a search.
    // Moving it to make room for the funnel would charge everyone a relearn.
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);

    const [first, second] = screen.getAllByRole("radio");
    expect(first).toHaveAccessibleName("Search everything");
    expect(second).toHaveAccessibleName("Filter this page");
  });

  it("names the group, so the pair is one control to a screen reader", () => {
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled={false} />);
    expect(screen.getByRole("radiogroup", { name: "Search mode" })).toBeInTheDocument();
  });

  it("reports the choice", () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="filter" onChange={onChange} filterDisabled={false} />);

    fireEvent.click(screen.getByRole("radio", { name: "Search everything" }));

    expect(onChange).toHaveBeenCalledWith("search");
  });

  it("greys the funnel where there is nothing to narrow", () => {
    // The Guide and the results page. Disabled rather than hidden: the control
    // should be the same shape on every tab, or its position in the row moves
    // as you navigate.
    render(<SearchModeToggle value="filter" onChange={() => {}} filterDisabled />);

    const funnel = screen.getByRole("radio", { name: "Filter this page" });
    expect(funnel).toBeDisabled();
    // Reads as Search while you are there, without touching the stored mode.
    expect(funnel).toHaveAttribute("aria-checked", "false");
    expect(screen.getByRole("radio", { name: "Search everything" }))
      .toHaveAttribute("aria-checked", "true");
  });

  it("cannot be talked into a mode it has greyed out", () => {
    const onChange = vi.fn();
    render(<SearchModeToggle value="filter" onChange={onChange} filterDisabled />);

    fireEvent.click(screen.getByRole("radio", { name: "Filter this page" }));

    expect(onChange).not.toHaveBeenCalled();
  });
});
