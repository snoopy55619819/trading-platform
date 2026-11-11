// The order book: ten price levels a side, the spread between them, and depth bars showing
// the running total. Greyed out, with the last known levels, while the feed cannot vouch
// for it (before its snapshot, after a gap, or with the feed down). Click a level to put
// its price on the order ticket.

import type { CSSProperties } from "react";

import type { BookMessage } from "../../api/marketData.ts";
import { formatCents } from "../../money.ts";
import { useMarket } from "../../market/hooks.ts";
import { Panel } from "../../ui/Shell.tsx";
import { useBookPrice } from "../ticket/draft.ts";
import { type LadderRow, ladder } from "./ladder.ts";
import "./book.css";

export function OrderBook({ symbol }: { symbol: string | undefined }) {
  const market = useMarket(symbol);
  return <BookView book={market.book} onPick={useBookPrice()} />;
}

export function BookView({ book, onPick }: { book: BookMessage | undefined; onPick: (priceCents: number) => void }) {
  const stale = book !== undefined && !book.live;
  return (
    <Panel title="Order book" actions={stale ? <span className="badge">Stale</span> : undefined}>
      {book === undefined ? (
        <p className="empty">Waiting for the book…</p>
      ) : book.bids.length === 0 && book.asks.length === 0 ? (
        <p className="empty">{book.live ? "No orders resting." : "Waiting for the book…"}</p>
      ) : (
        <Ladder book={book} stale={stale} onPick={onPick} />
      )}
    </Panel>
  );
}

function Ladder({ book, stale, onPick }: { book: BookMessage; stale: boolean; onPick: (priceCents: number) => void }) {
  const { asks, bids, spreadCents, midCents } = ladder(book);
  return (
    <table className={stale ? "data-table book stale" : "data-table book"}>
      <thead>
        <tr>
          <th>Price</th>
          <th>Size</th>
          <th>Total</th>
        </tr>
      </thead>
      <tbody>
        {asks.map((row) => (
          <Level key={`a${row.priceCents}`} row={row} side="ask" onPick={onPick} />
        ))}
        <tr className="book-spread">
          <td className="numbers">{midCents === undefined ? "–" : formatCents(midCents)}</td>
          <td colSpan={2} className="muted">
            {spreadCents === undefined ? "One side empty" : `Spread ${formatCents(spreadCents)}`}
          </td>
        </tr>
        {bids.map((row) => (
          <Level key={`b${row.priceCents}`} row={row} side="bid" onPick={onPick} />
        ))}
      </tbody>
    </table>
  );
}

function Level({ row, side, onPick }: { row: LadderRow; side: "bid" | "ask"; onPick: (priceCents: number) => void }) {
  return (
    <tr
      className={`book-${side}`}
      onClick={() => onPick(row.priceCents)}
      title={`Use ${formatCents(row.priceCents)} as the limit price`} style={{ "--depth": `${(row.depth * 100).toFixed(1)}%` } as CSSProperties}>
      <td className={`numbers ${side === "bid" ? "up" : "down"}`}>{formatCents(row.priceCents)}</td>
      <td className="numbers">{row.qty.toLocaleString("en-US")}</td>
      <td className="numbers">{row.total.toLocaleString("en-US")}</td>
    </tr>
  );
}
