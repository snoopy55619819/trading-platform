// The two display settings, in Settings and on the sign-in screen.

import { Segmented } from "../ui/controls.tsx";
import { FIXED_MODES, MODES, type ModeChoice, STYLES, STYLE_NAMES, type Style, themeStore, useTheme } from "./theme.ts";

const MODE_NAMES: Record<ModeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

export function ThemeSwitcher() {
  const theme = useTheme();
  return (
    <div style={{ display: "flex", gap: "var(--space-3)", flexWrap: "wrap" }}>
      <Segmented<Style>
        label="Style"
        options={STYLES.map((s) => ({ value: s, label: STYLE_NAMES[s] }))}
        value={theme.style}
        onChange={(style) => themeStore.setStyle(style)}
      />
      {FIXED_MODES[theme.style] ? (
        // The choice is kept for the other styles; this one only has one mode.
        <p className="muted" style={{ margin: 0, alignSelf: "center" }}>
          {STYLE_NAMES[theme.style]} is always {FIXED_MODES[theme.style]}.
        </p>
      ) : (
        <Segmented<ModeChoice>
          label="Mode"
          options={MODES.map((m) => ({ value: m, label: MODE_NAMES[m] }))}
          value={theme.modeChoice}
          onChange={(mode) => themeStore.setModeChoice(mode)}
        />
      )}
    </div>
  );
}
