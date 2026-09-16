import { createContext, useContext } from "react";

/**
 * Theme plumbing.
 *
 * Three settings - 'light', 'dark' and 'system' - resolve to one of two themes.
 * 'system' follows `prefers-color-scheme` live, so a machine that flips at
 * sunset flips the app with it. An explicit choice is remembered in
 * localStorage; 'system' is the default for anyone who never chose.
 *
 * The resolved theme is published two ways: the `dark` class on <html>, which
 * is what Tailwind's `darkMode: 'class'` keys off, and <meta name="theme-color">,
 * which is what mobile browsers paint their chrome with.
 *
 * index.html runs a copy of the resolve-and-apply step inline, before this
 * bundle loads, so the first paint is already the right theme. Keep the storage
 * key and the theme-color values there in step with the ones here.
 *
 * Consumers want `useTheme`. Only main.tsx needs ThemeProvider, which lives in
 * ./ThemeProvider.tsx - a component and a hook cannot share a file without
 * breaking Fast Refresh.
 */

export const THEME_STORAGE_KEY = "tablo:theme";

export type ThemeSetting = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/** In the order a picker should show them. */
export const THEME_SETTINGS: readonly ThemeSetting[] = ["light", "dark", "system"];

/**
 * What each setting is called on screen. Lives here rather than beside the
 * picker because more than one component names a setting - the picker's own
 * options, and the caption under it - and a module that exports a component
 * cannot also export constants without breaking Fast Refresh.
 */
export const THEME_LABELS: Record<ThemeSetting, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

/** Must match `--c-bg` in index.css, and the values in index.html's inline script. */
export const THEME_COLOR: Record<ResolvedTheme, string> = {
  light: "#f6f5f2",
  dark: "#0d0d14",
};

const DARK_QUERY = "(prefers-color-scheme: dark)";

export function isThemeSetting(value: unknown): value is ThemeSetting {
  return value === "light" || value === "dark" || value === "system";
}

export function readStoredSetting(): ThemeSetting {
  if (typeof window === "undefined") return "system";
  try {
    const stored = window.localStorage.getItem(THEME_STORAGE_KEY);
    return isThemeSetting(stored) ? stored : "system";
  } catch {
    // Private mode and locked-down storage both throw on access.
    return "system";
  }
}

export function writeStoredSetting(setting: ThemeSetting): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, setting);
  } catch {
    // Nothing to do - the choice still holds for this session.
  }
}

function matchDarkQuery(): MediaQueryList | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return null;
  }
  try {
    return window.matchMedia(DARK_QUERY);
  } catch {
    return null;
  }
}

/**
 * Dark is the fallback wherever the OS preference cannot be read - that is the
 * look the app shipped with.
 */
export function systemPrefersDark(): boolean {
  return matchDarkQuery()?.matches ?? true;
}

/** useSyncExternalStore subscriber for the OS preference. */
export function subscribeToSystemTheme(onChange: () => void): () => void {
  const query = matchDarkQuery();
  if (!query) return () => {};

  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }
  // Safari < 14 only has the deprecated pair.
  query.addListener(onChange);
  return () => query.removeListener(onChange);
}

export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === "light" || setting === "dark") return setting;
  return prefersDark ? "dark" : "light";
}

/** Push the resolved theme onto the document. Safe to call repeatedly. */
export function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;

  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;

  // index.html's inline script paints an anti-flash background straight onto
  // <html>. Once the stylesheet is in, the token owns that colour again.
  root.style.removeProperty("background-color");

  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", THEME_COLOR[resolved]);
}

export interface ThemeContextValue {
  /** What the user chose: 'light', 'dark', or 'system'. */
  theme: ThemeSetting;
  /** What that currently means: 'light' or 'dark'. */
  resolvedTheme: ResolvedTheme;
  setTheme: (setting: ThemeSetting) => void;
  /** Jump straight to the opposite of what is on screen. */
  toggleTheme: () => void;
}

/**
 * The fallback still works - it writes storage and repaints the document - so a
 * component rendered outside the provider (a unit test, say) behaves sanely
 * instead of throwing. It just will not re-render its subtree.
 */
function makeFallbackValue(): ThemeContextValue {
  const setting = readStoredSetting();
  const resolved = resolveTheme(setting, systemPrefersDark());
  const set = (next: ThemeSetting) => {
    writeStoredSetting(next);
    applyTheme(resolveTheme(next, systemPrefersDark()));
  };
  return {
    theme: setting,
    resolvedTheme: resolved,
    setTheme: set,
    toggleTheme: () => set(resolved === "dark" ? "light" : "dark"),
  };
}

export const ThemeContext = createContext<ThemeContextValue>(makeFallbackValue());

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
