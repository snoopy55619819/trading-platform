// The watchlist: the account's starred symbols, each with its last price, change on the day
// and a sparkline of today. Click a row to look at that symbol; unstar it with the star.
// Symbols are starred from the quote in the top bar.

import type { Security } from "../../api/backend.ts";
import { formatBps, formatCents } from "../../money.ts";
import { bucketStart } from "../../market/candles.ts";
import { useHistory, useMarket } from "../../market/hooks.ts";
import { useToggleWatch, useWatchlist } from "../../query/hooks.ts";
import { Panel } from "../../ui/Shell.tsx";
import { type Quote, quoteFrom } from "../header/quote.ts";
import { baselineY, sparklinePath, todaysCloses } from "./sparkline.ts";
import "./watchlist.css";

export function Watchlist({
  symbols,
  selected,
  onSelect,
}: {
  symbols: readonly Security[];
  selected: string | undefined;
  onSelect: (symbol: string) => void;
}) {
  const watchlist = useWatchlist();
  const toggle = useToggleWatch();
  const names = new Map(symbols.map((s) => [s.symbol, s.name]));
  const list = watchlist.data ?? [];
  return (
    <Panel title="Watchlist">
      {watchlist.isLoading ? (
        <p className="empty">Loading…</p>
      ) : watchlist.error ? (
        <p className="empty">Could not load the watchlist.</p>
      ) : list.length === 0 ? (
        <p className="empty">Nothing starred. Star a symbol from the top bar to keep it here.</p>
      ) : (
        <ul className="watchlist">
          {list.map((symbol) => (
            <WatchRow
              key={symbol}
              symbol={symbol}
              name={names.get(symbol)}
              selected={symbol === selected}
              onSelect={() => onSelect(symbol)}
              onUnstar={() => toggle.mutate({ symbol, watched: true })}
            />
          ))}
        </ul>
      )}
    </Panel>
  );
}

/** One row's data: live price joined with daily bars (for the change) and 5m bars (for the line). */
function WatchRow(props: { symbol: string; name: string | undefined; selected: boolean; onSelect: () => void; onUnstar: () => void }) {
  const market = useMarket(props.symbol);
  const daily = useHistory(props.symbol, "1d");
  const intraday = useHistory(props.symbol, "5m");
  const todayStart = bucketStart(Date.now(), "1d");
  const quote = quoteFrom(market, daily.bars, todayStart);
  const closes = todaysCloses(intraday.bars, todayStart);
  const previousClose = quote.lastCents !== undefined && quote.changeCents !== undefined ? quote.lastCents - quote.changeCents : undefined;
  return <WatchRowView {...props} quote={quote} closes={closes} previousClose={previousClose} />;
}

const SPARK_W = 64;
const SPARK_H = 20;

export function WatchRowView({
  symbol,
  name,
  selected,
  onSelect,
  onUnstar,
  quote,
  closes,
  previousClose,
}: {
  symbol: string;
  name: string | undefined;
  selected: boolean;
  onSelect: () => void;
  onUnstar: () => void;
  quote: Quote;
  closes: number[];
  previousClose: number | undefined;
}) {
  const direction = !quote.changeCents ? "" : quote.changeCents > 0 ? "up" : "down";
  const path = sparklinePath(closes, SPARK_W, SPARK_H, previousClose);
  return (
    <li className={selected ? "watch-row selected" : "watch-row"}>
      <button type="button" className="watch-main" onClick={onSelect} aria-current={selected || undefined}>
        <span className="watch-name">
          <strong>{symbol}</strong>
          {name && <span className="muted">{name}</span>}
        </span>
        <svg className={`spark ${direction}`} width={SPARK_W} height={SPARK_H} viewBox={`0 0 ${SPARK_W} ${SPARK_H}`} aria-hidden="true">
          {path && previousClose !== undefined && (
            <line className="spark-base" x1="0" x2={SPARK_W} y1={baselineY(closes, SPARK_H, previousClose)} y2={baselineY(closes, SPARK_H, previousClose)} />
          )}
          {path && <path d={path} />}
        </svg>
        <span className={quote.live ? "watch-price" : "watch-price stale"}>
          <span className="numbers">{quote.lastCents === undefined ? "–" : formatCents(quote.lastCents)}</span>
          <span className={`numbers watch-change ${direction}`}>{quote.changeBps === undefined ? "" : formatBps(quote.changeBps)}</span>
        </span>
      </button>
      <button type="button" className="star on" onClick={onUnstar} aria-label={`Remove ${symbol} from the watchlist`} title="Remove from watchlist">
        ★
      </button>
    </li>
  );
}
