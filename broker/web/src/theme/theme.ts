// The two display settings: mode (light or dark) and style (Pro, Active, Calm, Terminal).
// Saved in localStorage; mode follows the operating system until the user picks one, except
// for a style that only has one mode (Terminal is always dark). Applied as attributes on
// <html>, which is all tokens.css needs.
//
// index.html applies the saved settings before anything renders, so a reload never flashes
// the wrong colours; this module takes over once the app starts.

import { useSyncExternalStore } from "react";

export const MODES = ["system", "light", "dark"] as const;
export type ModeChoice = (typeof MODES)[number];
export type Mode = "light" | "dark";

export const STYLES = ["pro", "active", "calm", "terminal"] as const;
export type Style = (typeof STYLES)[number];
export const STYLE_NAMES: Record<Style, string> = { pro: "Pro", active: "Active", calm: "Calm", terminal: "Terminal" };
/** Styles drawn in one mode only, whatever the mode setting says. index.html repeats this. */
export const FIXED_MODES: Partial<Record<Style, Mode>> = { terminal: "dark" };
/** What a first visit looks like. index.html's pre-paint script repeats it: keep the two the same. */
export const DEFAULT_STYLE: Style = "active";

export interface Theme {
  /** What the user chose. */
  modeChoice: ModeChoice;
  /** What is shown: the choice, or the system's when the choice is "system". */
  mode: Mode;
  style: Style;
}

const KEY = "broker.theme";

/** Reads saved settings, accepting only known values: anything else is the default. */
export function parseSaved(text: string | null | undefined): { modeChoice: ModeChoice; style: Style } {
  let saved: { modeChoice?: unknown; style?: unknown } = {};
  try {
    saved = text ? (JSON.parse(text) as typeof saved) : {};
  } catch {
    // corrupt: defaults
  }
  return {
    modeChoice: MODES.includes(saved.modeChoice as ModeChoice) ? (saved.modeChoice as ModeChoice) : "system",
    style: STYLES.includes(saved.style as Style) ? (saved.style as Style) : DEFAULT_STYLE,
  };
}

/** The mode shown: the style's own if it has one, else the choice, else the system's. */
export function resolveMode(choice: ModeChoice, systemDark: boolean, style: Style): Mode {
  const fixed = FIXED_MODES[style];
  if (fixed) return fixed;
  if (choice === "system") return systemDark ? "dark" : "light";
  return choice;
}

function readSaved(): string | null {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null; // storage blocked: settings just do not persist
  }
}

class ThemeStore {
  private theme: Theme;
  private readonly listeners = new Set<() => void>();
  private readonly media = typeof matchMedia === "undefined" ? undefined : matchMedia("(prefers-color-scheme: dark)");

  constructor() {
    const saved = parseSaved(typeof localStorage === "undefined" ? null : readSaved());
    this.theme = { ...saved, mode: resolveMode(saved.modeChoice, this.media?.matches ?? false, saved.style) };
    // Follow the system while the user has not chosen.
    this.media?.addEventListener("change", () => this.update({}));
    this.apply();
  }

  get = (): Theme => this.theme;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  setModeChoice(modeChoice: ModeChoice): void {
    this.update({ modeChoice });
  }

  setStyle(style: Style): void {
    this.update({ style });
  }

  private update(change: Partial<Pick<Theme, "modeChoice" | "style">>): void {
    const modeChoice = change.modeChoice ?? this.theme.modeChoice;
    const style = change.style ?? this.theme.style;
    this.theme = { modeChoice, style, mode: resolveMode(modeChoice, this.media?.matches ?? false, style) };
    try {
      localStorage.setItem(KEY, JSON.stringify({ modeChoice, style }));
    } catch {
      // as above
    }
    this.apply();
    for (const listener of this.listeners) listener();
  }

  private apply(): void {
    if (typeof document === "undefined") return;
    document.documentElement.dataset.mode = this.theme.mode;
    document.documentElement.dataset.style = this.theme.style;
  }
}

export const themeStore = new ThemeStore();

export function useTheme(): Theme {
  return useSyncExternalStore(themeStore.subscribe, themeStore.get);
}

/**
 * The current value of some tokens, for things drawn outside CSS (the chart's canvas).
 * Read after the attributes change, so call it from an effect that depends on the theme.
 */
export function readTokens<const K extends string>(names: readonly K[]): Record<K, string> {
  const style = getComputedStyle(document.documentElement);
  return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(`--${name}`).trim()])) as Record<K, string>;
}
