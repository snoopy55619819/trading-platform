// Time and sales: the symbol's latest trades, newest at the top. Coloured by which side
// took liquidity: a buyer lifting the offer is green, a seller hitting the bid is red.

import type { TradeMessage } from "../../api/marketData.ts";
import { formatCents } from "../../money.ts";
import { useRecentTrades } from "../../market/hooks.ts";
import { Panel } from "../../ui/Shell.tsx";

export function TimeAndSales({ symbol }: { symbol: string | undefined }) {
  const { trades, isLoading, error } = useRecentTrades(symbol);
  if (!symbol) {
    return (
      <Panel title="Time and sales">
        <p className="empty">Pick a symbol.</p>
      </Panel>
    );
  }
  return <TapeView trades={trades} isLoading={isLoading} failed={error !== null && trades.length === 0} />;
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

export function TapeView({ trades, isLoading, failed }: { trades: TradeMessage[]; isLoading: boolean; failed: boolean }) {
  return (
    <Panel title="Time and sales">
      {isLoading ? (
        <p className="empty">Loading…</p>
      ) : failed ? (
        <p className="empty">Could not load recent trades.</p>
      ) : trades.length === 0 ? (
        <p className="empty">No trades yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Price</th>
              <th>Size</th>
            </tr>
          </thead>
          <tbody>
            {trades.map((t) => (
              <tr key={t.tradeId}>
                <td className="numbers muted">{time(t.ts)}</td>
                <td className={`numbers ${t.aggressor === "BUY" ? "up" : "down"}`}>{formatCents(t.priceCents)}</td>
                <td className="numbers">{t.qty.toLocaleString("en-US")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Panel>
  );
}
