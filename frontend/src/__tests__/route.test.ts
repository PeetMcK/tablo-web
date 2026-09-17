import { describe, it, expect, beforeEach } from "vitest";
import { parseRoute, writeRoute, type Route } from "../lib/route";

/**
 * The hash tokenizer, which every tab depends on and which had three tests
 * covering one shape of URL. Search widened it (a query string), and the
 * player widened it again (history entries) — both changed how every other
 * route parses, so this covers the forms rather than one example of one.
 *
 * `routeHistory.test.ts` covers push-vs-replace; this covers what the hash
 * means.
 */
describe("parseRoute", () => {
  it("reads each tab", () => {
    expect(parseRoute("#/live").tab).toBe("live");
    expect(parseRoute("#/grid").tab).toBe("grid");
    expect(parseRoute("#/library").tab).toBe("library");
    expect(parseRoute("#/search").tab).toBe("search");
  });

  it("falls back to Live TV for anything it does not recognise", () => {
    for (const hash of ["", "#", "#/", "#/nonsense", "#/live2"]) {
      expect(parseRoute(hash).tab).toBe("live");
    }
  });

  it("accepts the name the UI gives the Guide tab", () => {
    // The tab is "Guide" in the topbar and `grid` in the route, so the
    // obvious hand-typed URL used to land on Live TV without a word.
    expect(parseRoute("#/guide").tab).toBe("grid");
    expect(parseRoute("#/guide/ch/S79600_007_01").watch)
      .toEqual({ kind: "live", id: "S79600_007_01" });
    // Still one canonical address: writing normalises it back.
    writeRoute(parseRoute("#/guide"));
    expect(window.location.hash).toBe("#/grid");
  });

  it("tolerates a missing or doubled slash", () => {
    expect(parseRoute("#live").tab).toBe("live");
    expect(parseRoute("#//grid//").tab).toBe("grid");
  });

  it("reads a channel, decoding whatever the identifier contains", () => {
    expect(parseRoute("#/live/ch/S79600_007_01").watch)
      .toEqual({ kind: "live", id: "S79600_007_01" });
    // Device identifiers are opaque; a slash or a space in one must survive.
    expect(parseRoute("#/live/ch/a%2Fb%20c").watch)
      .toEqual({ kind: "live", id: "a/b c" });
  });

  it("reads a recording only when the id is a number", () => {
    expect(parseRoute("#/library/rec/80888").watch)
      .toEqual({ kind: "recording", id: 80888 });
    // `Number("12abc")` is NaN and `Number("")` is 0; neither may become an id.
    for (const bad of ["abc", "12abc", "-1", "1.5", ""]) {
      expect(parseRoute(`#/library/rec/${bad}`).watch).toBeNull();
    }
  });

  it("ignores a watch segment it does not understand", () => {
    expect(parseRoute("#/live/ch").watch).toBeNull();
    expect(parseRoute("#/live/wat/1").watch).toBeNull();
  });

  it("reads the query alongside the path, not instead of it", () => {
    expect(parseRoute("#/search?q=broncos")).toEqual({
      tab: "search", watch: null, q: "broncos",
    });
    // Percent-encoded and plus-encoded spaces both decode.
    expect(parseRoute("#/search?q=denver%20broncos").q).toBe("denver broncos");
    expect(parseRoute("#/search?q=denver+broncos").q).toBe("denver broncos");
    // A query rides along with a watch, and with any tab.
    expect(parseRoute("#/library/rec/80888?q=nfl")).toEqual({
      tab: "library", watch: { kind: "recording", id: 80888 }, q: "nfl",
    });
    // Other parameters are not the query.
    expect(parseRoute("#/search?a=1&q=nfl&b=2").q).toBe("nfl");
    expect(parseRoute("#/search?a=1").q).toBeUndefined();
    expect(parseRoute("#/search").q).toBeUndefined();
  });
});

describe("writeRoute", () => {
  beforeEach(() => window.history.replaceState(null, "", "#/live"));

  const forms: Route[] = [
    { tab: "live", watch: null },
    { tab: "grid", watch: null },
    { tab: "library", watch: null },
    { tab: "live", watch: { kind: "live", id: "S79600_007_01" } },
    { tab: "live", watch: { kind: "live", id: "a/b c" } },
    { tab: "library", watch: { kind: "recording", id: 80888 } },
    { tab: "search", watch: null, q: "denver broncos" },
  ];

  it.each(forms)("round-trips %j", (route) => {
    writeRoute(route);
    const back = parseRoute(window.location.hash);
    expect(back.tab).toBe(route.tab);
    expect(back.watch).toEqual(route.watch);
    expect(back.q).toBe(route.q);
  });

  it("writes the query only for the search tab", () => {
    // Every other tab's `q` is the topbar box, which is not where you are.
    writeRoute({ tab: "grid", watch: null, q: "broncos" });
    expect(window.location.hash).toBe("#/grid");
  });

  it("leaves the hash alone when it already says this", () => {
    writeRoute({ tab: "grid", watch: null });
    const before = window.history.length;
    writeRoute({ tab: "grid", watch: null });
    expect(window.location.hash).toBe("#/grid");
    expect(window.history.length).toBe(before);
  });
});
