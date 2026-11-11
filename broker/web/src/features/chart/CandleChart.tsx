// Candles and volume, drawn by lightweight-charts. A view: it gets bars and draws them.
//
// The chart is created once and fed changes: a live trade updates the last bar or opens a
// new one (see updates.ts), anything else replaces the data. Colours come from the theme's
// tokens and are re-read whenever the mode or style changes. Times are shown in the
// browser's time zone; the library itself only knows UTC.

import {
  CandlestickSeries,
  type CandlestickData,
  ColorType,
  HistogramSeries,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  TickMarkType,
  type UTCTimestamp,
  createChart,
} from "lightweight-charts";
import { useEffect, useRef } from "react";

import type { Bar } from "../../api/marketData.ts";
import { readTokens, useTheme } from "../../theme/theme.ts";
import { chartChange } from "./updates.ts";

const seconds = (bar: Bar) => (Date.parse(bar.t) / 1000) as UTCTimestamp;
const candle = (bar: Bar): CandlestickData => ({
  time: seconds(bar),
  open: bar.openCents / 100,
  high: bar.highCents / 100,
  low: bar.lowCents / 100,
  close: bar.closeCents / 100,
});

interface Colours {
  surface: string;
  text: string;
  grid: string;
  up: string;
  down: string;
  font: string;
}

function readColours(): Colours {
  const t = readTokens(["surface", "text-muted", "border", "up", "down", "font"]);
  return { surface: t.surface, text: t["text-muted"], grid: t.border, up: t.up, down: t.down, font: t.font };
}

/** "#0f7b4a" at 40% -> "#0f7b4a66". Tokens are six-digit hex; anything else is left alone. */
const translucent = (hex: string, alpha: number) =>
  /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(alpha * 255).toString(16).padStart(2, "0") : hex;

const volume = (bar: Bar, c: Colours): HistogramData => ({
  time: seconds(bar),
  value: bar.volume,
  color: translucent(bar.closeCents >= bar.openCents ? c.up : c.down, 0.4),
});

function localTime(time: Time, withDate: boolean): string {
  const date = new Date((time as number) * 1000);
  const hm = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}` : hm;
}

export function CandleChart({ bars, viewKey, intraday }: { bars: Bar[]; viewKey: string; intraday: boolean }) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(undefined);
  const candles = useRef<ISeriesApi<"Candlestick">>(undefined);
  const volumes = useRef<ISeriesApi<"Histogram">>(undefined);
  const drawn = useRef<{ bars: Bar[]; key: string } | undefined>(undefined);
  const colours = useRef<Colours>(undefined);
  const theme = useTheme();

  // Created once per mount; removed on unmount.
  useEffect(() => {
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { attributionLogo: false },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: 4 },
      crosshair: { mode: 0 },
    });
    chart.current = api;
    candles.current = api.addSeries(CandlestickSeries, {
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      borderVisible: false,
    });
    volumes.current = api.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    // Volume along the bottom fifth, under the candles.
    api.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    candles.current.priceScale().applyOptions({ scaleMargins: { top: 0.08, bottom: 0.25 } });
    return () => {
      api.remove();
      chart.current = undefined;
      drawn.current = undefined;
    };
  }, []);

  // Times in the browser's zone, with the date when the interval is a day or longer.
  useEffect(() => {
    chart.current?.applyOptions({
      localization: { timeFormatter: (t: Time) => localTime(t, true) },
      timeScale: {
        timeVisible: intraday,
        tickMarkFormatter: (t: Time, type: TickMarkType) =>
          type === TickMarkType.Time || type === TickMarkType.TimeWithSeconds
            ? localTime(t, false)
            : new Date((t as number) * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" }),
      },
    });
  }, [intraday]);

  // Colours follow the theme. Volume bars carry their own colour, so they are redrawn too.
  useEffect(() => {
    const c = readColours();
    colours.current = c;
    chart.current?.applyOptions({
      layout: { background: { type: ColorType.Solid, color: c.surface }, textColor: c.text, fontFamily: c.font },
      grid: { vertLines: { color: c.grid }, horzLines: { color: c.grid } },
    });
    candles.current?.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    if (drawn.current) volumes.current?.setData(drawn.current.bars.map((b) => volume(b, c)));
  }, [theme.mode, theme.style]);

  // The data: an update when only the tail moved, otherwise everything.
  useEffect(() => {
    const c = colours.current ?? readColours();
    const previous = drawn.current?.key === viewKey ? drawn.current.bars : undefined;
    const change = chartChange(previous, bars);
    if (change.kind === "update") {
      for (const bar of change.bars) {
        candles.current?.update(candle(bar));
        volumes.current?.update(volume(bar, c));
      }
    } else if (change.kind === "reset") {
      candles.current?.setData(bars.map(candle));
      volumes.current?.setData(bars.map((b) => volume(b, c)));
      // A new symbol or interval starts at the latest bars; a refetch keeps where you scrolled.
      if (drawn.current?.key !== viewKey && bars.length > 0) {
        chart.current?.timeScale().setVisibleLogicalRange({ from: Math.max(0, bars.length - 120), to: bars.length + 4 });
      }
    }
    drawn.current = { bars, key: viewKey };
  }, [bars, viewKey]);

  return <div ref={host} className="chart" />;
}
