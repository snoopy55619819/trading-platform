// Time and sales: the symbol's latest trades, newest at the top. Coloured by which side
// took liquidity: a buyer lifting the offer is green, a seller hitting the bid is red.
// How many rows it shows (5, 10 or 50) is a setting, saved in this browser.

import type { TradeMessage } from "../../api/marketData.ts";
import { formatCents } from "../../money.ts";
import { useRecentTrades } from "../../market/hooks.ts";
import { TAPE_ROWS, type TapeRows, settingsStore, useSettings } from "../../settings.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Panel } from "../../ui/Shell.tsx";

export function TimeAndSales({ symbol }: { symbol: string | undefined }) {
  const { trades, isLoading, error } = useRecentTrades(symbol);
  const { tapeRows } = useSettings();
  const chooseRows = (rows: TapeRows) => settingsStore.update({ tapeRows: rows });
  if (!symbol) {
    return (
      <Panel title="Time and sales" actions={<RowsPicker rows={tapeRows} onChange={chooseRows} />}>
        <p className="empty">Pick a symbol.</p>
      </Panel>
    );
  }
  return (
    <TapeView
      trades={trades}
      isLoading={isLoading}
      failed={error !== null && trades.length === 0}
      rows={tapeRows}
      onRowsChange={chooseRows}
    />
  );
}

function RowsPicker({ rows, onChange }: { rows: TapeRows; onChange: (rows: TapeRows) => void }) {
  return (
    <Segmented
      label="Trades shown"
      options={TAPE_ROWS.map((n) => ({ value: String(n), label: n }))}
      value={String(rows)}
      onChange={(value) => onChange(Number(value) as TapeRows)}
    />
  );
}

const time = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour12: false });

export function TapeView({
  trades,
  isLoading,
  failed,
  rows,
  onRowsChange,
}: {
  trades: TradeMessage[];
  isLoading: boolean;
  failed: boolean;
  rows: TapeRows;
  onRowsChange: (rows: TapeRows) => void;
}) {
  return (
    <Panel title="Time and sales" actions={<RowsPicker rows={rows} onChange={onRowsChange} />}>
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
            {trades.slice(0, rows).map((t) => (
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
