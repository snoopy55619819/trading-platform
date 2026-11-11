// Step 4's placeholder: the trading screen's frame in the current style and mode, with
// stand-in panels, so the layouts and tokens can be checked before any section exists.
// Replaced by the real sections in step 5.

import { Panel, Shell } from "./ui/Shell.tsx";
import { ThemeSwitcher } from "./theme/ThemeSwitcher.tsx";
import { STYLE_NAMES, useTheme } from "./theme/theme.ts";

function Sample() {
  // A few rows that show text, numbers, and the up and down colours together.
  const rows = [
    ["ACME", "42.15", "+0.42%", "up"],
    ["CRUX", "286.55", "-1.10%", "down"],
    ["GRID", "33.12", "+0.05%", "up"],
  ] as const;
  return (
    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "var(--fs-sm)" }}>
      <tbody>
        {rows.map(([symbol, price, change, dir]) => (
          <tr key={symbol} style={{ height: "var(--row-h)" }}>
            <td>{symbol}</td>
            <td className="numbers" style={{ textAlign: "right" }}>{price}</td>
            <td className={`numbers ${dir}`} style={{ textAlign: "right" }}>{change}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function App() {
  const theme = useTheme();
  return (
    <Shell
      areas={{
        header: (
          <Panel>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "var(--space-3)", flexWrap: "wrap" }}>
              <strong style={{ fontSize: "var(--fs-lg)" }}>Broker</strong>
              <span className="muted">
                {STYLE_NAMES[theme.style]} · {theme.mode}
              </span>
              <ThemeSwitcher />
            </div>
          </Panel>
        ),
        watch: <Panel title="Watchlist"><Sample /></Panel>,
        chart: (
          <Panel title="ACME · 1m">
            <div className="numbers" style={{ fontSize: "var(--fs-xl)", fontWeight: "var(--weight-strong)" }}>
              42.15 <span className="up" style={{ fontSize: "var(--fs-md)" }}>+0.18 (+0.42%)</span>
            </div>
          </Panel>
        ),
        book: <Panel title="Order book"><Sample /></Panel>,
        tape: <Panel title="Time and sales"><Sample /></Panel>,
        ticket: (
          <Panel title="Order ticket">
            <div style={{ display: "flex", gap: "var(--space-3)" }}>
              <button type="button" className="button buy" style={{ flex: 1 }}>Buy</button>
              <button type="button" className="button sell" style={{ flex: 1 }}>Sell</button>
            </div>
          </Panel>
        ),
        bottom: <Panel title="Positions"><Sample /></Panel>,
      }}
    />
  );
}
