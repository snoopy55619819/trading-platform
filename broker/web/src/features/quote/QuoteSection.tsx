// The Quote section: the selected symbol's ticker and company, last price, change on the
// day, and today's high, low and volume, with a star to add it to (or take it off) the
// watchlist. Bid and ask are left to the order book, which sits under it.
// The container joins the live feed with the daily bars; the view only draws numbers.

import { formatBps, formatCents } from "../../money.ts";
import { bucketStart } from "../../market/candles.ts";
import { useHistory, useMarket } from "../../market/hooks.ts";
import { useToggleWatch, useWatchlist } from "../../query/hooks.ts";
import { Panel } from "../../ui/Shell.tsx";
import { type Quote, quoteFrom } from "./quote.ts";
import "./quote.css";

export function QuoteSection({ symbol, name }: { symbol: string | undefined; name: string | undefined }) {
  if (!symbol) {
    return (
      <Panel title="Quote">
        <p className="empty">Pick a symbol.</p>
      </Panel>
    );
  }
  return <QuoteContainer symbol={symbol} name={name} />;
}

function QuoteContainer({ symbol, name }: { symbol: string; name: string | undefined }) {
  const market = useMarket(symbol);
  const daily = useHistory(symbol, "1d");
  const watchlist = useWatchlist();
  const toggle = useToggleWatch();
  const quote = quoteFrom(market, daily.bars, bucketStart(Date.now(), "1d"));
  const watched = watchlist.data?.includes(symbol) ?? false;
  return (
    <QuoteView
      symbol={symbol}
      name={name}
      quote={quote}
      watched={watched}
      onToggleWatch={watchlist.data && !toggle.isPending ? () => toggle.mutate({ symbol, watched }) : undefined}
    />
  );
}

const price = (cents: number | undefined) => (cents === undefined ? "–" : formatCents(cents));

export function QuoteView({
  symbol,
  name,
  quote,
  watched,
  onToggleWatch,
}: {
  symbol: string;
  name: string | undefined;
  quote: Quote;
  watched: boolean;
  /** Undefined while the watchlist is loading or a change is in flight. */
  onToggleWatch: (() => void) | undefined;
}) {
  const direction = quote.changeCents === undefined || quote.changeCents === 0 ? "" : quote.changeCents > 0 ? "up" : "down";
  const star = (
    <button
      type="button"
      className={watched ? "star on" : "star"}
      onClick={onToggleWatch}
      disabled={!onToggleWatch}
      aria-pressed={watched}
      aria-label={watched ? `Remove ${symbol} from the watchlist` : `Add ${symbol} to the watchlist`}
      title={watched ? "Remove from watchlist" : "Add to watchlist"}
    >
      {watched ? "★" : "☆"}
    </button>
  );
  return (
    <Panel title="Quote" actions={star}>
      <div className={quote.live ? "quote" : "quote stale"} aria-live="polite">
        <div className="quote-name">
          <strong>{symbol}</strong>
          {name && (
            <span className="muted" title={name}>
              {name}
            </span>
          )}
        </div>
        <div className="quote-price">
          <span className="quote-last numbers">{price(quote.lastCents)}</span>
          {quote.changeCents !== undefined && quote.changeBps !== undefined && (
            <span className={`quote-change numbers ${direction}`}>
              {quote.changeCents > 0 ? "+" : ""}
              {formatCents(quote.changeCents)} ({formatBps(quote.changeBps)})
            </span>
          )}
        </div>
        <dl className="quote-facts">
          <div>
            <dt>High</dt>
            <dd className="numbers">{price(quote.highCents)}</dd>
          </div>
          <div>
            <dt>Low</dt>
            <dd className="numbers">{price(quote.lowCents)}</dd>
          </div>
          <div>
            <dt>Volume</dt>
            <dd className="numbers">{quote.volume.toLocaleString("en-US")}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}
