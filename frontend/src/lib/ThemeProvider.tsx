import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  applyTheme,
  isThemeSetting,
  readStoredSetting,
  resolveTheme,
  subscribeToSystemTheme,
  systemPrefersDark,
  ThemeContext,
  THEME_STORAGE_KEY,
  writeStoredSetting,
  type ThemeContextValue,
  type ThemeSetting,
} from "./theme";

/** Server render has no media query to ask; dark is the shipped default. */
const serverPrefersDark = () => true;

/**
 * Owns the theme setting and keeps the document in step with it. Mounted once,
 * in main.tsx. Everything else reads it through `useTheme` from ./theme.
 */
export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setThemeState] = useState<ThemeSetting>(readStoredSetting);

  // Track the OS preference even while an explicit theme is selected, so
  // switching back to 'system' lands on the right one immediately.
  const prefersDark = useSyncExternalStore(
    subscribeToSystemTheme,
    systemPrefersDark,
    serverPrefersDark,
  );

  const resolvedTheme = resolveTheme(theme, prefersDark);

  useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  // A second tab changing the setting should not leave this one stale.
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== THEME_STORAGE_KEY) return;
      setThemeState(isThemeSetting(event.newValue) ? event.newValue : "system");
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const setTheme = useCallback((next: ThemeSetting) => {
    setThemeState(next);
    writeStoredSetting(next);
  }, []);

  const toggleTheme = useCallback(() => {
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  }, [resolvedTheme, setTheme]);

  const value = useMemo<ThemeContextValue>(
    () => ({ theme, resolvedTheme, setTheme, toggleTheme }),
    [theme, resolvedTheme, setTheme, toggleTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}
