import { describe, it, expect } from "vitest";

/**
 * The search surfaces shipped outside the theme-token system.
 *
 * Every colour in the app resolves through a CSS custom property (see
 * index.css and tailwind.config.js) so one class works in both themes with no
 * `dark:` at the call site. The four files below were written against the
 * pre-token palette instead — `text-white`, `bg-white/5`, `border-white/10`,
 * `bg-black/60` — which is invisible on a pale ground: in light mode the
 * results page rendered near-white text on a near-white page.
 *
 * This is a source scan rather than a render assertion because the bug is in
 * the class strings themselves, not in any one rendered state: a row can only
 * be wrong in the theme the test does not happen to mount.
 */

// Sources as text, via Vite's `?raw`. `import.meta.glob` is resolved at build
// time, so the paths are checked rather than string-concatenated at runtime,
// and no Node `fs` types are needed — the app's tsconfig ships `vite/client`
// only, and `tsc -b` is part of `npm run build`.
const SOURCES = import.meta.glob(
  [
    "../components/SearchResultsView.tsx",
    "../components/SearchResultRow.tsx",
    "../components/SearchDropdown.tsx",
    "../components/CommandPalette.tsx",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

/** Tailwind palette literals that cannot follow the theme.
 *
 * The colour prefix is required rather than optional, so `font-black` — a
 * weight, not a colour — does not read as a hardcoded fill. */
const PROP = "text|bg|border|placeholder|ring|divide|from|to|via|fill|stroke|shadow|outline|decoration|caret";
const RAMP = "emerald|red|amber|slate|zinc|gray|neutral|sky|indigo|violet|rose|teal|blue|green|yellow|orange|purple|pink";
const HARDCODED = new RegExp(
  `\\b(?:${PROP})-(?:white|black)(?:\\/\\d+)?\\b|\\b(?:${PROP})-(?:${RAMP})-\\d{2,3}\\b`,
  "g",
);

/** Class attributes only — prose in a comment may name an old colour. */
function classNames(src: string): string[] {
  return [...src.matchAll(/className=(?:"([^"]*)"|\{`([^`]*)`\})/g)]
    .map(m => m[1] ?? m[2]);
}

describe("the search surfaces", () => {
  it.each(Object.entries(SOURCES))(
    "themes %s through tokens, not the raw palette",
    (_path, src) => {
      const offenders = classNames(src).flatMap(cls => cls.match(HARDCODED) ?? []);
      expect(offenders).toEqual([]);
    },
  );

  it("scans all four files", () => {
    expect(Object.keys(SOURCES)).toHaveLength(4);
  });
});
