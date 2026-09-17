import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import { ContentFilterMenu } from "../components/ContentFilterMenu";
import { CONTENT_FILTERS } from "../lib/contentFilters";

/**
 * What the row of filter chips becomes when there is no room for a row.
 *
 * Eight chips need about 810px. Below a phone's width they cannot be a row at
 * all, and a hidden-overflow scroller is how they used to disappear — so at
 * that width they collapse into this, which is the same pill-and-popover the
 * date jump beside it already is.
 */
describe("the content filter menu", () => {
  afterEach(() => vi.restoreAllMocks());

  it("names the filter in force", () => {
    render(<ContentFilterMenu value="sports" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: /Sports/ })).toBeInTheDocument();
  });

  it("stays shut until it is asked for", () => {
    render(<ContentFilterMenu value="all" onChange={() => {}} />);

    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.getByRole("button", { name: /All/ }))
      .toHaveAttribute("aria-expanded", "false");
  });

  it("offers every filter once open", () => {
    render(<ContentFilterMenu value="all" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    const items = screen.getAllByRole("menuitemradio");
    expect(items).toHaveLength(CONTENT_FILTERS.length);
    for (const f of CONTENT_FILTERS) {
      expect(screen.getByRole("menuitemradio", { name: new RegExp(f.label) }))
        .toBeInTheDocument();
    }
  });

  it("says which one is in force", () => {
    render(<ContentFilterMenu value="news" onChange={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /News/ }));

    expect(screen.getByRole("menuitemradio", { name: /News/ }))
      .toHaveAttribute("aria-checked", "true");
    expect(screen.getByRole("menuitemradio", { name: /Movies/ }))
      .toHaveAttribute("aria-checked", "false");
  });

  it("picks a filter and closes", () => {
    const onChange = vi.fn();
    render(<ContentFilterMenu value="all" onChange={onChange} />);
    fireEvent.click(screen.getByRole("button", { name: /All/ }));

    fireEvent.click(screen.getByRole("menuitemradio", { name: /Documentary/ }));

    expect(onChange).toHaveBeenCalledWith("documentary");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  it("closes on Escape, and on a click outside it", () => {
    // Bound only while open, the way the jump control's are: a listener living
    // for the life of the guide would run on every click in the app.
    render(<ContentFilterMenu value="all" onChange={() => {}} />);
    const trigger = screen.getByRole("button", { name: /All/ });

    fireEvent.click(trigger);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("menu")).toBeNull();

    fireEvent.click(trigger);
    expect(screen.getByRole("menu")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
