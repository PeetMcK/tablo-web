import { describe, it, expect } from "vitest";

import { defaultBoxFor, resizePipWindow, PIP_BOX_DEFAULT } from "../lib/pipWindow";

/** A screen big enough that nothing here is clamped by it. */
const ROOMY = { width: 3840, height: 2160 };

const ratio = (b: { width: number; height: number }) => b.width / b.height;

describe("Reset PiP", () => {
  it("goes to the default area at the picture's shape", () => {
    const area = PIP_BOX_DEFAULT.width * PIP_BOX_DEFAULT.height;
    const box = defaultBoxFor({ width: 640, height: 480 }, ROOMY);
    expect(ratio(box)).toBeCloseTo(4 / 3, 2);
    expect(box.width * box.height).toBeGreaterThan(area * 0.99);
    expect(box.width * box.height).toBeLessThan(area * 1.01);
  });

  it("falls back to the default box when nothing has decoded", () => {
    expect(defaultBoxFor({ width: 0, height: 0 }, ROOMY)).toEqual(PIP_BOX_DEFAULT);
  });
});

describe("resizing the window itself", () => {
  it("adds back the browser's own chrome, so the content lands on the box", () => {
    // `resizeTo` speaks in outer size and a pop-out has a title bar above the
    // content; asking for the content box verbatim leaves the picture short.
    const w = {
      innerWidth: 400, innerHeight: 225, outerWidth: 400, outerHeight: 263,
      resizeTo(width: number, height: number) {
        this.outerWidth = width;
        this.outerHeight = height;
        this.innerWidth = width;
        this.innerHeight = height - 38;
      },
    };
    expect(resizePipWindow(w as unknown as Window, { width: 800, height: 450 }))
      .toEqual({ ok: true });
    expect(w.outerHeight).toBe(450 + 38);
  });

  it("reports a refusal rather than throwing", () => {
    // The method needs a user activation and the browser may say no. The
    // window then keeps the shape it was given, which is no worse than not
    // trying — so nothing downstream may depend on this working. The reason
    // is carried out because from the outside a refusal and a clamp look the
    // same, and they are not the same problem.
    const w = {
      innerWidth: 400, innerHeight: 225, outerWidth: 400, outerHeight: 225,
      resizeTo: () => { throw new Error("refused"); },
    };
    expect(resizePipWindow(w as unknown as Window, { width: 800, height: 450 }))
      .toEqual({ ok: false, why: "refused" });
  });

  it("calls a clamped resize a failure, since the shape is still wrong", () => {
    // Chrome enforces a minimum pop-out size. A browser that silently clamps
    // to it has not thrown and has not done what was asked either, and a log
    // saying the resize worked would send us hunting in the wrong place.
    const w = {
      innerWidth: 940, innerHeight: 631, outerWidth: 940, outerHeight: 669,
      resizeTo: () => {},
    };
    expect(resizePipWindow(w as unknown as Window, { width: 480, height: 270 }))
      .toEqual({ ok: false, why: "clamped to 940x631" });
  });
});
