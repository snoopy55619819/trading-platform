// The two display settings. Lives in Settings in step 5; shown in the header until then.

import { Segmented } from "../ui/controls.tsx";
import { MODES, type ModeChoice, STYLES, STYLE_NAMES, type Style, themeStore, useTheme } from "./theme.ts";

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
      <Segmented<ModeChoice>
        label="Mode"
        options={MODES.map((m) => ({ value: m, label: MODE_NAMES[m] }))}
        value={theme.modeChoice}
        onChange={(mode) => themeStore.setModeChoice(mode)}
      />
    </div>
  );
}
