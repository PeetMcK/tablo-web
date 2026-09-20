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

// Node 22 and later define their own global `localStorage` and `Storage`,
// inert unless the process was started with `--localstorage-file` — and
// Vitest's jsdom environment leaves a global that already exists alone rather
// than overwriting it. So jsdom's never land: `localStorage` reads as
// `undefined` and a test file dies on the first line that touches it
// (`Cannot read properties of undefined (reading 'clear')`), while `Storage`
// resolves to Node's class, which nothing in the environment is an instance
// of. The document URL is not the cause — jsdom is already at
// http://localhost:3000 — and `sessionStorage` survives only because Node has
// no built-in of that name.
//
// Borrow real ones from a throwaway jsdom rather than hand-rolling a Storage,
// so key coercion, `length` and `key()` behave as the browser does. All three
// names come from that one realm on purpose: `vi.spyOn(Storage.prototype, …)`
// is how a test makes storage throw (private mode), and that only reaches an
// instance whose prototype *is* the global `Storage.prototype`. Taking the
// class from one realm and the instances from another silently breaks it.
if (typeof globalThis.localStorage === "undefined") {
  // jsdom ships no types and `@types/jsdom` is not a dependency here; three
  // names off one window is the whole of what this needs from it. If the types
  // ever arrive, tsc flags this suppression as unused and it can go.
  // @ts-expect-error - untyped module
  const { JSDOM } = await import("jsdom");
  const w = new JSDOM("", { url: "http://localhost:3000" })
    .window as Record<string, unknown>;
  for (const target of new Set<object>([globalThis, globalThis.window])) {
    if (!target) continue;
    for (const name of ["Storage", "localStorage", "sessionStorage"] as const) {
      Object.defineProperty(target, name, {
        value: w[name],
        configurable: true,
        writable: true,
      });
    }
  }
}
