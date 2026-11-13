// How much the market's prices behave like a real stock's (ADR 0008). Measured on one-minute
// candles: the "stylized facts" real price series share (Cont 2001), and the ones that are
// easy to see on a chart. Pure, so it is tested directly; realism/measure.ts fetches the
// candles and prints the result.
//
// A real stock, roughly, on one-minute returns:
//   flat minutes          few in a busy name; long unchanged runs are rare in market hours
//   excess kurtosis       5 to 20 (fat tails: big candles happen without news); a random
//                         walk with normal shocks gives about 0
//   autocorrelation       about 0 from lag 2 on (lag 1 a little negative: bid-ask bounce)
//   |return| autocorr.    positive and slow to fade over tens of minutes (busy and quiet
//                         stretches cluster); a plain random walk gives about 0
//   volume and |return|   move together (positive correlation)
//   after news            the move builds over minutes, rather than all arriving in the
//                         first one and stopping
//   news share            the share of all price movement that comes in the minutes just
//                         after headlines: a minority in a real stock

/** One one-minute candle, as market-data's GET /history returns it. */
export interface Candle {
  t: string;
  closeCents: number;
  volume: number;
}

/** A headline that should move the price: its time and which way. */
export interface NewsEvent {
  ts: string;
  sign: 1 | -1;
}

/** One minute of the series, with a gap in trading filled by the previous close. */
export interface Minute {
  /** Start of the minute, epoch ms. */
  t: number;
  closeCents: number;
  volume: number;
}

const MINUTE_MS = 60_000;

/**
 * Candles to a gapless series of minutes. A minute with no trades has no candle; its price
 * did not change, so it is the previous close with no volume. That matters: flat stretches
 * are what is being measured.
 */
export function minutes(candles: readonly Candle[]): Minute[] {
  const sorted = [...candles].sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  const out: Minute[] = [];
  for (const candle of sorted) {
    const t = Date.parse(candle.t);
    const last = out.at(-1);
    if (last) for (let gap = last.t + MINUTE_MS; gap < t; gap += MINUTE_MS) out.push({ t: gap, closeCents: last.closeCents, volume: 0 });
    out.push({ t, closeCents: candle.closeCents, volume: candle.volume });
  }
  return out;
}

/** Log returns between consecutive minutes; returns[i] is the move into minutes[i + 1]. */
export function logReturns(series: readonly Minute[]): number[] {
  return series.slice(1).map((m, i) => Math.log(m.closeCents / series[i]!.closeCents));
}

const mean = (xs: readonly number[]): number => (xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Excess kurtosis: 0 for normal shocks, higher when big moves are more common than that. */
export function excessKurtosis(xs: readonly number[]): number {
  const m = mean(xs);
  const m2 = mean(xs.map((x) => (x - m) ** 2));
  const m4 = mean(xs.map((x) => (x - m) ** 4));
  return m2 === 0 ? 0 : m4 / m2 ** 2 - 3;
}

/** Correlation of a series with itself `lag` steps later. */
export function autocorrelation(xs: readonly number[], lag: number): number {
  if (lag >= xs.length) return 0;
  const m = mean(xs);
  const variance = xs.reduce((a, x) => a + (x - m) ** 2, 0);
  if (variance === 0) return 0;
  let sum = 0;
  for (let i = 0; i + lag < xs.length; i++) sum += (xs[i]! - m) * (xs[i + lag]! - m);
  return sum / variance;
}

/** Pearson correlation of two series of the same length. */
export function correlation(xs: readonly number[], ys: readonly number[]): number {
  const mx = mean(xs);
  const my = mean(ys);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
    syy += (ys[i]! - my) ** 2;
  }
  return sxx === 0 || syy === 0 ? 0 : sxy / Math.sqrt(sxx * syy);
}

/** The share of minutes whose price did not change, and the longest run of them. */
export function flatness(returns: readonly number[]): { flatShare: number; longestFlat: number } {
  let flat = 0;
  let run = 0;
  let longest = 0;
  for (const r of returns) {
    if (r === 0) {
      flat++;
      longest = Math.max(longest, ++run);
    } else run = 0;
  }
  return { flatShare: returns.length === 0 ? 0 : flat / returns.length, longestFlat: longest };
}

/** Minutes after a headline that count as "its" reaction, for the news share. */
export const NEWS_WINDOW_MIN = 5;
/** Minutes after a headline the average reaction is followed for. */
export const RESPONSE_MINUTES = [1, 2, 5, 10, 30] as const;

/**
 * The average path after moving news, signed so good and bad news both count as up: the
 * move from the close before the headline to each of RESPONSE_MINUTES after it, in basis
 * points (hundredths of a percent). A step is about the same number at every minute; a
 * reaction that arrives over minutes grows from minute 1 to minute 30. Also the share of
 * all squared returns that fall in the NEWS_WINDOW_MIN minutes after a headline.
 */
export function newsResponse(
  series: readonly Minute[],
  news: readonly NewsEvent[],
): { events: number; path: Record<number, number>; newsShare: number } {
  const returns = logReturns(series);
  const index = (ms: number) => Math.floor((ms - series[0]!.t) / MINUTE_MS);
  const last = RESPONSE_MINUTES.at(-1)!;
  const sums = new Map<number, number>(RESPONSE_MINUTES.map((m) => [m, 0]));
  const inWindow = new Set<number>();
  let events = 0;
  for (const event of news) {
    const at = index(Date.parse(event.ts)); // the minute the headline landed in
    if (at < 1 || at + last >= series.length) continue;
    events++;
    const before = Math.log(series[at - 1]!.closeCents);
    for (const m of RESPONSE_MINUTES) sums.set(m, sums.get(m)! + event.sign * (Math.log(series[at - 1 + m]!.closeCents) - before));
    for (let k = 0; k < NEWS_WINDOW_MIN; k++) inWindow.add(at - 1 + k); // returns into minutes at..at+4
  }
  const path: Record<number, number> = {};
  for (const m of RESPONSE_MINUTES) path[m] = events === 0 ? 0 : (sums.get(m)! / events) * 10_000;
  const total = returns.reduce((a, r) => a + r * r, 0);
  const near = [...inWindow].reduce((a, i) => a + (returns[i] ?? 0) ** 2, 0);
  return { events, path, newsShare: total === 0 ? 0 : near / total };
}

/** Lags the clustering of absolute returns is reported at. */
export const ABS_LAGS = [1, 5, 15, 30, 60] as const;

export interface Realism {
  minutes: number;
  flatShare: number;
  longestFlat: number;
  /** Standard deviation of one-minute returns, in basis points (hundredths of a percent). */
  volBps: number;
  excessKurtosis: number;
  /** Autocorrelation of returns at lags 1 and 2. */
  acf1: number;
  acf2: number;
  /** Autocorrelation of absolute returns at each of ABS_LAGS. */
  absAcf: Record<number, number>;
  volumeAbsCorr: number;
  news: ReturnType<typeof newsResponse>;
}

/** Every measure, for one symbol's candles and its moving headlines. */
export function measure(candles: readonly Candle[], news: readonly NewsEvent[]): Realism {
  const series = minutes(candles);
  const returns = logReturns(series);
  const abs = returns.map(Math.abs);
  const sd = Math.sqrt(mean(returns.map((r) => (r - mean(returns)) ** 2)));
  const absAcf: Record<number, number> = {};
  for (const lag of ABS_LAGS) absAcf[lag] = autocorrelation(abs, lag);
  return {
    minutes: series.length,
    ...flatness(returns),
    volBps: sd * 10_000,
    excessKurtosis: excessKurtosis(returns),
    acf1: autocorrelation(returns, 1),
    acf2: autocorrelation(returns, 2),
    absAcf,
    volumeAbsCorr: correlation(series.slice(1).map((m) => m.volume), abs),
    news: series.length > 1 ? newsResponse(series, news) : { events: 0, path: {}, newsShare: 0 },
  };
}
