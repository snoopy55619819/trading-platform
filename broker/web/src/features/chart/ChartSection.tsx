// The chart section: the selected symbol's candles and volume, an interval picker, and the
// current candle kept moving by live trades (folded in by useHistory).

import { useState } from "react";

import { INTERVALS, type Interval } from "../../api/marketData.ts";
import { useHistory } from "../../market/hooks.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Panel } from "../../ui/Shell.tsx";
import { CandleChart } from "./CandleChart.tsx";
import "./chart.css";

const KEY = "broker.interval";

function savedInterval(): Interval {
  try {
    const saved = localStorage.getItem(KEY);
    return INTERVALS.includes(saved as Interval) ? (saved as Interval) : "1m";
  } catch {
    return "1m";
  }
}

export function ChartSection({ symbol }: { symbol: string | undefined }) {
  const [interval, setInterval] = useState<Interval>(savedInterval);
  const history = useHistory(symbol, interval);
  const choose = (next: Interval) => {
    setInterval(next);
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // storage blocked: just not remembered
    }
  };
  const message = !symbol
    ? "Pick a symbol."
    : history.error
      ? "Could not load the chart."
      : history.isLoading
        ? "Loading…"
        : history.bars?.length === 0
          ? `No trades yet at ${interval}.`
          : undefined;
  return (
    <Panel
      title={symbol ? `${symbol} · ${interval}` : "Chart"}
      actions={<Segmented label="Interval" options={INTERVALS.map((i) => ({ value: i, label: i }))} value={interval} onChange={choose} />}
    >
      <div className="chart-frame">
        <CandleChart bars={history.bars ?? []} viewKey={`${symbol}/${interval}`} intraday={interval !== "1d"} />
        {message && <p className="empty chart-message">{message}</p>}
      </div>
    </Panel>
  );
}
