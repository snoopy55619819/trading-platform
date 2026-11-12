// Candles and volume, drawn by lightweight-charts. A view: it gets bars and draws them.
//
// The chart is created once and fed changes: a live trade updates the last bar or opens a
// new one (see updates.ts), anything else replaces the data. Colours come from the theme's
// tokens and are re-read whenever the mode or style changes. Times are shown in the
// browser's time zone; the library itself only knows UTC.
//
// A legend sits over the top left: the symbol and interval, then the candle under the
// cursor, or the latest one when the cursor is elsewhere. The crosshair labels the price on
// the right axis and the time on the bottom one. Wheel, drag and pinch zoom and pan are the
// library's own and left on; the range buttons only set where the view starts.
//
// News (ADR 0006): a dot above each candle where one of the symbol's headlines landed,
// green for good news, red for bad, grey for neutral. Hovering that candle puts the headline
// in the legend.
//
// The highest high and lowest low among the candles in view are marked "H" and "L" with
// their price, using the library's series markers. They are worked out again whenever the
// view moves (zoom, pan, a new range) and whenever the bars change.

import {
  CandlestickSeries,
  type CandlestickData,
  ColorType,
  CrosshairMode,
  type MouseEventParams,
  HistogramSeries,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type Time,
  TickMarkType,
  type UTCTimestamp,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  createChart,
  createSeriesMarkers,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";

import type { Bar, Interval, NewsMessage } from "../../api/marketData.ts";
import { type BarNews, markerTone, newsOnBars } from "../../market/news.ts";
import { formatCents } from "../../money.ts";
import { readTokens, useTheme } from "../../theme/theme.ts";
import { visibleExtremes } from "./extremes.ts";
import { legendFor } from "./legend.ts";
import { RIGHT_OFFSET, type Range, frame } from "./range.ts";
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
  crosshair: string;
}

function readColours(): Colours {
  const t = readTokens(["surface", "text-muted", "border", "up", "down", "font", "stale"]);
  return { surface: t.surface, text: t["text-muted"], grid: t.border, up: t.up, down: t.down, font: t.font, crosshair: t.stale };
}

/** "#0f7b4a" at 40% -> "#0f7b4a66". Tokens are six-digit hex; anything else is left alone. */
const translucent = (hex: string, alpha: number) =>
  /^#[0-9a-f]{6}$/i.test(hex) ? hex + Math.round(alpha * 255).toString(16).padStart(2, "0") : hex;

const volume = (bar: Bar, c: Colours): HistogramData => ({
  time: seconds(bar),
  value: bar.volume,
  color: translucent(bar.closeCents >= bar.openCents ? c.up : c.down, 0.4),
});

/**
 * "H 101.25" above the highest candle in view and "L 98.10" below the lowest, and a dot
 * above each candle with news. The library wants markers in time order.
 */
function drawMarkers(
  chart: IChartApi | undefined,
  markers: ISeriesMarkersPluginApi<Time> | undefined,
  bars: Bar[],
  news: readonly BarNews[],
  c: Colours,
): void {
  const range = chart?.timeScale().getVisibleLogicalRange();
  const found = range ? visibleExtremes(bars, range.from, range.to) : undefined;
  const all: SeriesMarker<Time>[] = [];
  if (found) {
    all.push(
      { time: seconds(bars[found.high.index]!), position: "aboveBar", shape: "arrowDown", color: c.text, size: 0.5, text: `H ${formatCents(found.high.cents)}` },
      { time: seconds(bars[found.low.index]!), position: "belowBar", shape: "arrowUp", color: c.text, size: 0.5, text: `L ${formatCents(found.low.cents)}` },
    );
  }
  for (const { index, headlines } of news) {
    const bar = bars[index];
    if (!bar) continue;
    const tone = markerTone(headlines);
    const color = tone === "POSITIVE" ? c.up : tone === "NEGATIVE" ? c.down : c.text;
    all.push({ time: seconds(bar), position: "aboveBar", shape: "circle", color, size: 0.6 });
  }
  markers?.setMarkers(all.sort((a, b) => (a.time as number) - (b.time as number)));
}

function localTime(time: Time, withDate: boolean): string {
  const date = new Date((time as number) * 1000);
  const hm = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  return withDate ? `${date.toLocaleDateString(undefined, { month: "short", day: "numeric" })} ${hm}` : hm;
}

export function CandleChart({
  bars,
  viewKey,
  intraday,
  title,
  range,
  interval,
  frameKey,
  news,
}: {
  bars: Bar[];
  /** Symbol and interval: when it changes, the data is replaced rather than updated. */
  viewKey: string;
  intraday: boolean;
  /** The legend's first line, "ACME · 1m". */
  title: string | undefined;
  range: Range;
  interval: Interval;
  /** When this changes (and is set), the view is framed to `range` at the latest bars. */
  frameKey: string | undefined;
  /** The symbol's headlines, any order. */
  news: readonly NewsMessage[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi>(undefined);
  const candles = useRef<ISeriesApi<"Candlestick">>(undefined);
  const volumes = useRef<ISeriesApi<"Histogram">>(undefined);
  const markers = useRef<ISeriesMarkersPluginApi<Time>>(undefined);
  const drawn = useRef<{ bars: Bar[]; key: string } | undefined>(undefined);
  const colours = useRef<Colours>(undefined);
  const framed = useRef<string>(undefined);
  const barNews = useMemo(() => newsOnBars(bars, news, interval), [bars, news, interval]);
  const newsRef = useRef<readonly BarNews[]>(barNews);
  newsRef.current = barNews;
  // The bar index under the cursor; undefined when the cursor is off the chart's bars.
  const [hovered, setHovered] = useState<number>();
  const theme = useTheme();

  // Created once per mount; removed on unmount.
  useEffect(() => {
    const api = createChart(host.current!, {
      autoSize: true,
      layout: { attributionLogo: false },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, rightOffset: RIGHT_OFFSET },
      // Normal: the crosshair follows the cursor, so the right axis shows the price under it.
      crosshair: { mode: CrosshairMode.Normal },
    });
    chart.current = api;
    candles.current = api.addSeries(CandlestickSeries, {
      priceFormat: { type: "price", precision: 2, minMove: 0.01 },
      borderVisible: false,
    });
    markers.current = createSeriesMarkers(candles.current);
    volumes.current = api.addSeries(HistogramSeries, { priceScaleId: "", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    // Volume along the bottom fifth, under the candles.
    api.priceScale("").applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    // Room at the top for the legend.
    candles.current.priceScale().applyOptions({ scaleMargins: { top: 0.18, bottom: 0.25 } });
    // Logical indexes match positions in the bars, since both series get every bar.
    const onMove = (param: MouseEventParams<Time>) => {
      const index = param.logical === undefined || param.time === undefined ? undefined : Math.round(param.logical);
      setHovered(index);
    };
    api.subscribeCrosshairMove(onMove);
    // Zoom, pan and a new frame all move the visible range; the marks follow.
    const onRange = () =>
      drawMarkers(api, markers.current, drawn.current?.bars ?? [], newsRef.current, colours.current ?? readColours());
    api.timeScale().subscribeVisibleLogicalRangeChange(onRange);
    return () => {
      api.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
      api.unsubscribeCrosshairMove(onMove);
      api.remove();
      chart.current = undefined;
      drawn.current = undefined;
      framed.current = undefined;
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
      crosshair: {
        vertLine: { color: c.crosshair, labelBackgroundColor: c.text },
        horzLine: { color: c.crosshair, labelBackgroundColor: c.text },
      },
    });
    candles.current?.applyOptions({ upColor: c.up, downColor: c.down, wickUpColor: c.up, wickDownColor: c.down });
    if (drawn.current) {
      volumes.current?.setData(drawn.current.bars.map((b) => volume(b, c)));
      drawMarkers(chart.current, markers.current, drawn.current.bars, newsRef.current, c);
    }
  }, [theme.mode, theme.style]);

  // The data: an update when only the tail moved, otherwise everything.
  useEffect(() => {
    const c = colours.current ?? readColours();
    const previous = drawn.current?.key === viewKey ? drawn.current.bars : undefined;
    const change = chartChange(previous, bars);
    // Set before drawing, so a range change fired while drawing marks these bars.
    drawn.current = { bars, key: viewKey };
    if (change.kind === "update") {
      for (const bar of change.bars) {
        candles.current?.update(candle(bar));
        volumes.current?.update(volume(bar, c));
      }
    } else if (change.kind === "reset") {
      candles.current?.setData(bars.map(candle));
      volumes.current?.setData(bars.map((b) => volume(b, c)));
    }
    // A new view or range starts at the latest bars; a refetch or a live trade keeps where
    // you scrolled or zoomed.
    if (frameKey !== undefined && framed.current !== frameKey) {
      const logical = frame(bars, range, interval);
      if (logical) {
        chart.current?.timeScale().setVisibleLogicalRange(logical);
        framed.current = frameKey;
      }
    }
    // A live trade can set a new high or low without moving the view.
    drawMarkers(chart.current, markers.current, bars, barNews, c);
  }, [bars, viewKey, frameKey, range, interval]);

  // A headline can arrive without the bars changing.
  useEffect(() => {
    if (drawn.current) drawMarkers(chart.current, markers.current, drawn.current.bars, barNews, colours.current ?? readColours());
  }, [barNews]);

  const shown = hovered !== undefined && bars[hovered] ? hovered : bars.length - 1;
  const bar = bars[shown];
  const legend = bar ? legendFor(bar) : undefined;
  const headlines = barNews.find((n) => n.index === shown)?.headlines ?? [];
  return (
    <>
      <div ref={host} className="chart" />
      {title && (
        <div className="chart-legend numbers" aria-live="off">
          <span className="chart-legend-title">{title}</span>
          {legend && (
            <span className="chart-legend-values">
              <span>
                <span className="muted">O</span> {legend.open}
              </span>
              <span>
                <span className="muted">H</span> {legend.high}
              </span>
              <span>
                <span className="muted">L</span> {legend.low}
              </span>
              <span>
                <span className="muted">C</span> {legend.close}
              </span>
              <span className={legend.direction === "flat" ? undefined : legend.direction}>{legend.change}</span>
              <span>
                <span className="muted">Vol</span> {legend.volume}
              </span>
            </span>
          )}
          {headlines[0] && (
            <span className="chart-legend-news">
              <span className={headlines[0].tone === "POSITIVE" ? "up" : headlines[0].tone === "NEGATIVE" ? "down" : "muted"}>
                {headlines[0].tone === "POSITIVE" ? "▲" : headlines[0].tone === "NEGATIVE" ? "▼" : "•"}
              </span>{" "}
              {headlines[0].headline}
              {headlines.length > 1 && <span className="muted"> (+{headlines.length - 1} more)</span>}
            </span>
          )}
        </div>
      )}
    </>
  );
}
