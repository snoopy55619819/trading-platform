// The periodic status table: is the market alive, is the spread sane, are the market
// makers' inventories under control?

import type { Context } from "./agents/context.ts";
import type { MarketMaker } from "./agents/market-maker.ts";
import { formatCents } from "./fix/codec.ts";

const TAKERS = ["NOISE", "MOMENTUM", "MEANREV"];

const dollars = (cents: number): string =>
  `${cents < 0 ? "-" : ""}$${formatCents(Math.abs(Math.round(cents)))}`;

export function report(context: Context & { makers: MarketMaker[]; gaps: number; news: number | undefined }): string {
  const { listings, fair, feed, positions, orders } = context;
  const rows = [["SYMBOL", "FAIR", "BID", "ASK", "SPREAD", "LAST", "MM INV", "MM P&L", "PULLS", "HEAT"]];
  let makerPnl = 0;
  const takerPnl = new Map(TAKERS.map((name) => [name, 0]));
  for (const [symbol] of listings) {
    const mirror = feed.mirrors.get(symbol);
    const fairCents = Math.round(fair.get(symbol)?.value() ?? 0);
    const bid = mirror?.bestBid();
    const ask = mirror?.bestAsk();
    const maker = `MM-${symbol}`;
    const pnl = positions.pnl(maker, symbol, fairCents);
    makerPnl += pnl;
    for (const name of TAKERS) {
      takerPnl.set(name, (takerPnl.get(name) ?? 0) + positions.pnl(name, symbol, fairCents));
    }
    rows.push([
      symbol,
      formatCents(fairCents),
      bid === undefined ? "-" : formatCents(bid),
      ask === undefined ? "-" : formatCents(ask),
      bid === undefined || ask === undefined ? "-" : formatCents(ask - bid),
      mirror?.lastTradeCents === undefined ? "-" : formatCents(mirror.lastTradeCents),
      String(positions.get(maker, symbol).qty),
      dollars(pnl),
      String(context.makers.find((m) => m.name === maker)?.pulls ?? 0),
      (fair.get(symbol)?.heat ?? 0).toFixed(2),
    ]);
  }
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  const table = rows.map((r) => r.map((cell, i) => cell.padStart(widths[i]!)).join("  ")).join("\n");
  const { sent, cancels, fills, rejects, throttled } = orders.stats;
  const takers = TAKERS.map((name) => `${name} ${dollars(takerPnl.get(name) ?? 0)}`).join(", ");
  return [
    "",
    table,
    `market makers ${dollars(makerPnl)}; ${takers} (marked at fair value)`,
    `orders ${sent}, cancels ${cancels}, fills ${fills}, rejects ${rejects}, throttled ${throttled}, ` +
      `feed gaps ${context.gaps}, activity x${context.activity.toFixed(1)}, ` +
      (context.news === undefined ? "news off" : `headlines ${context.news}`),
  ].join("\n");
}
