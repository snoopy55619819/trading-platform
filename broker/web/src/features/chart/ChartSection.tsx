// The chart section: the selected symbol's candles and volume, an interval picker, range
// buttons, and the current candle kept moving by live trades (folded in by useHistory).
//
// Interval and range are chosen together (see range.ts): picking a range may change the
// interval, picking an interval may change the range, and both are remembered.

import { useState } from "react";

import { INTERVALS, type Interval } from "../../api/marketData.ts";
import { useHistory, useNews } from "../../market/hooks.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Panel } from "../../ui/Shell.tsx";
import { CandleChart } from "./CandleChart.tsx";
import { RANGES, type Range, barsToFetch, fits, intervalForRange, rangeForInterval } from "./range.ts";
import "./chart.css";

const INTERVAL_KEY = "broker.interval";
const RANGE_KEY = "broker.chartRange";

function saved<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function save(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage blocked: just not remembered
  }
}

interface View {
  interval: Interval;
  range: Range;
  /** Counts range clicks, so clicking the chosen range again goes back to it at the latest bars. */
  clicks: number;
}

function savedView(): View {
  const interval = saved(INTERVAL_KEY, INTERVALS, "1m");
  const range = saved(RANGE_KEY, RANGES, "6H");
  // Saved separately, so they may not suit each other (an older save had no range).
  return { interval, range: fits(range, interval) ? range : rangeForInterval(interval, range), clicks: 0 };
}

export function ChartSection({ symbol }: { symbol: string | undefined }) {
  const [view, setView] = useState<View>(savedView);
  const { interval, range } = view;
  const count = barsToFetch(range, interval);
  const history = useHistory(symbol, interval, count);
  // The symbol's latest headlines, for the dots on the chart: about ten days' worth.
  const news = useNews(symbol, 200);

  const update = (next: View) => {
    setView(next);
    save(INTERVAL_KEY, next.interval);
    save(RANGE_KEY, next.range);
  };
  const chooseInterval = (next: Interval) => update({ ...view, interval: next, range: rangeForInterval(next, range) });
  const chooseRange = (next: Range) => update({ interval: intervalForRange(next, interval), range: next, clicks: view.clicks + 1 });

  const message = !symbol
    ? "Pick a symbol."
    : history.error
      ? "Could not load the chart."
      : history.isLoading
        ? "Loading…"
        : history.bars?.length === 0
          ? `No trades yet at ${interval}.`
          : undefined;
  const viewKey = `${symbol}/${interval}`;
  return (
    <Panel
      className="chart-panel"
      title={symbol ?? "Chart"}
      actions={<Segmented label="Interval" options={INTERVALS.map((i) => ({ value: i, label: i }))} value={interval} onChange={chooseInterval} />}
    >
      <div className="chart-section">
        <div className="chart-frame">
          <CandleChart
            bars={history.bars ?? []}
            viewKey={viewKey}
            intraday={interval !== "1d"}
            title={symbol ? `${symbol} · ${interval}` : undefined}
            range={range}
            interval={interval}
            // Framed again for a new view, a new range or a range click, and once more when
            // a longer history replaces the placeholder (the frame may reach further back).
            frameKey={history.isPlaceholderData ? undefined : `${viewKey}/${count}/${range}/${view.clicks}`}
            news={symbol ? news.news : []}
          />
          {message && <p className="empty chart-message">{message}</p>}
        </div>
        <div className="chart-ranges">
          <Segmented label="Range" options={RANGES.map((r) => ({ value: r, label: r }))} value={range} onChange={chooseRange} />
        </div>
      </div>
    </Panel>
  );
}
