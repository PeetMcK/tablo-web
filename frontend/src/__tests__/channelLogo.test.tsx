import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChannelLogo } from "../components/ChannelLogo";

describe("ChannelLogo", () => {
  it("renders the logo when a URL is present", () => {
    render(<ChannelLogo src="https://example.test/pbs.png" callSign="PBS" />);
    expect(screen.getByRole("img", { name: "PBS" })).toHaveAttribute(
      "src",
      "https://example.test/pbs.png",
    );
  });

  it("falls back to the antenna mark when there is no URL", () => {
    render(<ChannelLogo src={null} callSign="KIDS" />);
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText("KIDS")).toBeInTheDocument();
  });

  it("falls back to the antenna mark when the logo 404s", () => {
    // Some Tablo logo URLs are dead; a bare <img> would show the browser's
    // broken-image glyph.
    render(<ChannelLogo src="https://example.test/gone.png" callSign="KIDS" />);
    const img = screen.getByRole("img", { name: "KIDS" });
    fireEvent.error(img);

    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByLabelText("KIDS")).toBeInTheDocument();
  });

  it("retries for a different channel rather than inheriting a failure", () => {
    const { rerender } = render(<ChannelLogo src="https://example.test/gone.png" callSign="KIDS" />);
    fireEvent.error(screen.getByRole("img", { name: "KIDS" }));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();

    rerender(<ChannelLogo src="https://example.test/cbs.png" callSign="CBS" />);
    expect(screen.getByRole("img", { name: "CBS" })).toBeInTheDocument();
  });
});
