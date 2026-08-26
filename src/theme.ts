export const THEME_PREFERENCE_KEY = "codex-web:theme";
export const GUEST_READER_THEME_PREFERENCE_KEY = "codex-web:guest-reader-theme";

export type ThemePreference = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

const THEME_PREFERENCES: ThemePreference[] = ["light", "dark", "system"];
const THEME_CANVAS_COLORS: Record<ResolvedTheme, string> = {
  light: "#fafbff",
  dark: "#17181b",
};

export function normalizeThemePreference(value: unknown, fallback: ThemePreference = "light"): ThemePreference {
  return typeof value === "string" && THEME_PREFERENCES.includes(value as ThemePreference)
    ? value as ThemePreference
    : fallback;
}

export function resolveTheme(preference: ThemePreference, systemPrefersDark: boolean): ResolvedTheme {
  return preference === "system" ? (systemPrefersDark ? "dark" : "light") : preference;
}

export function themeCanvasColor(theme: ResolvedTheme): string {
  return THEME_CANVAS_COLORS[theme];
}

export function readStoredThemePreference(storage: Pick<Storage, "getItem"> = window.localStorage, key = THEME_PREFERENCE_KEY): ThemePreference {
  try {
    return normalizeThemePreference(storage.getItem(key));
  } catch {
    return "light";
  }
}

export function applyThemePreference(
  preference: ThemePreference,
  systemPrefersDark = window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false,
  root: HTMLElement = document.documentElement,
): ResolvedTheme {
  const resolved = resolveTheme(preference, systemPrefersDark);
  root.dataset.theme = resolved;
  root.dataset.themePreference = preference;
  root.style.colorScheme = resolved;
  root.ownerDocument?.querySelector<HTMLMetaElement>('meta[name="theme-color"]')
    ?.setAttribute("content", themeCanvasColor(resolved));
  return resolved;
}
