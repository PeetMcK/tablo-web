// Registers jest-dom matchers (toBeInTheDocument, toBeDisabled, ...) with Vitest.
// The dependency was already present but never wired into the test config.
import "@testing-library/jest-dom/vitest";

// jsdom implements no `matchMedia`, and the code that reads the motion
// preference is called from a pointer handler — so the throw surfaced as an
// unhandled error rather than a failure, seven per run, while every assertion
// still passed. Stubbed here rather than guarded in `drag.ts`: every real
// browser has this, the gap is the test environment's, and a spy over this
// lets a test say what the viewer asked for.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}
