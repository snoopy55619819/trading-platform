// The activity panel: positions, open orders and order history, as tabs. Each tab is its
// own component, so the layout editor can later give any of them a panel of its own.
//
// Positions are valued at the live last trade, else the last stored trade, else the
// previous close (quoteFrom). Order rows expand to show the order's events.

import { useState } from "react";

import type { Holding, Order } from "../../api/backend.ts";
import { formatBps, formatCents, formatSignedDollars, formatDollars } from "../../money.ts";
import { bucketStart } from "../../market/candles.ts";
import { useHistory, useMarket } from "../../market/hooks.ts";
import { useCancelOrder, useOrder, useOrders, usePositions } from "../../query/hooks.ts";
import { Panel } from "../../ui/Shell.tsx";
import { Segmented } from "../../ui/controls.tsx";
import { quoteFrom } from "../header/quote.ts";
import { STATUS_LABEL, eventText, orderPrice, orderTime, positionValue, splitOrders } from "./orders.ts";
import "./activity.css";

type Tab = "positions" | "open" | "history";

export function Activity({ selected, onSelect }: { selected: string | undefined; onSelect: (symbol: string) => void }) {
  const [tab, setTab] = useState<Tab>("positions");
  const [onlySelected, setOnlySelected] = useState(false);
  const positions = usePositions();
  const orders = useOrders();
  const { open, done } = splitOrders(orders.data ?? [], onlySelected ? selected : undefined);
  const holdings = (positions.data?.holdings ?? []).filter((h) => h.qtySettled + h.qtyUnsettled > 0);

  return (
    <Panel
      title={
        <Segmented
          label="Activity"
          options={[
            { value: "positions", label: `Positions${holdings.length ? ` ${holdings.length}` : ""}` },
            { value: "open", label: `Open orders${open.length ? ` ${open.length}` : ""}` },
            { value: "history", label: "History" },
          ]}
          value={tab}
          onChange={setTab}
        />
      }
      actions={
        tab !== "positions" && selected ? (
          <label className="only-symbol">
            <input type="checkbox" checked={onlySelected} onChange={(e) => setOnlySelected(e.target.checked)} />
            {selected} only
          </label>
        ) : undefined
      }
    >
      {tab === "positions" ? (
        positions.isLoading ? (
          <p className="empty">Loading…</p>
        ) : positions.error ? (
          <p className="empty">Could not load positions.</p>
        ) : (
          <Positions holdings={holdings} onSelect={onSelect} />
        )
      ) : orders.isLoading ? (
        <p className="empty">Loading…</p>
      ) : orders.error ? (
        <p className="empty">Could not load orders.</p>
      ) : (
        <Orders key={tab} orders={tab === "open" ? open : done} working={tab === "open"} />
      )}
    </Panel>
  );
}

function Positions({ holdings, onSelect }: { holdings: Holding[]; onSelect: (symbol: string) => void }) {
  if (holdings.length === 0) return <p className="empty">No positions yet. Buy something from the order ticket.</p>;
  return (
    <table className="data-table activity">
      <thead>
        <tr>
          <th>Symbol</th>
          <th>Shares</th>
          <th>Avg cost</th>
          <th>Price</th>
          <th>Value</th>
          <th>P&amp;L</th>
        </tr>
      </thead>
      <tbody>
        {holdings.map((h) => (
          <PositionRow key={h.symbol} holding={h} onSelect={() => onSelect(h.symbol)} />
        ))}
      </tbody>
    </table>
  );
}

function PositionRow({ holding, onSelect }: { holding: Holding; onSelect: () => void }) {
  const market = useMarket(holding.symbol);
  const daily = useHistory(holding.symbol, "1d");
  const price = quoteFrom(market, daily.bars, bucketStart(Date.now(), "1d")).lastCents;
  const v = positionValue(holding, price);
  const direction = !v.pnlCents ? "" : v.pnlCents > 0 ? "up" : "down";
  return (
    <tr className="clickable" onClick={onSelect}>
      <td>
        <strong>{holding.symbol}</strong>
      </td>
      <td className="numbers">
        {v.qty.toLocaleString("en-US")}
        {holding.qtyUnsettled > 0 && <span className="muted unsettled"> ({holding.qtyUnsettled.toLocaleString("en-US")} unsettled)</span>}
      </td>
      <td className="numbers">{holding.avgCostCents === null ? "–" : formatCents(holding.avgCostCents)}</td>
      <td className="numbers">{price === undefined ? "–" : formatCents(price)}</td>
      <td className="numbers">{v.marketValueCents === undefined ? "–" : formatDollars(v.marketValueCents)}</td>
      <td className={`numbers ${direction}`}>
        {v.pnlCents === undefined ? "–" : formatSignedDollars(v.pnlCents)}
        {v.pnlBps !== undefined && <span className="pnl-pct"> {formatBps(v.pnlBps)}</span>}
      </td>
    </tr>
  );
}

function Orders({ orders, working }: { orders: Order[]; working: boolean }) {
  const [expanded, setExpanded] = useState<string | undefined>(undefined);
  if (orders.length === 0) return <p className="empty">{working ? "No open orders." : "No finished orders yet."}</p>;
  return (
    <table className="data-table activity">
      <thead>
        <tr>
          <th>Time</th>
          <th>Symbol</th>
          <th>Side</th>
          <th>Price</th>
          <th>Shares</th>
          <th>Filled</th>
          <th>{working ? "Status" : "Avg price"}</th>
          <th>{working ? "" : "Status"}</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <OrderRows
            key={o.orderId}
            order={o}
            working={working}
            expanded={expanded === o.orderId}
            onToggle={() => setExpanded(expanded === o.orderId ? undefined : o.orderId)}
          />
        ))}
      </tbody>
    </table>
  );
}

function OrderRows({ order, working, expanded, onToggle }: { order: Order; working: boolean; expanded: boolean; onToggle: () => void }) {
  const cancel = useCancelOrder();
  const side = order.side === "BUY" ? "up" : "down";
  return (
    <>
      <tr className={expanded ? "clickable expanded" : "clickable"} onClick={onToggle} aria-expanded={expanded}>
        <td className="numbers muted">{orderTime(order.createdAt)}</td>
        <td>
          <strong>{order.symbol}</strong>
        </td>
        <td className={side}>{order.side === "BUY" ? "Buy" : "Sell"}</td>
        <td className="numbers">{orderPrice(order)}</td>
        <td className="numbers">{order.qty.toLocaleString("en-US")}</td>
        <td className="numbers">{order.filledQty.toLocaleString("en-US")}</td>
        {working ? (
          <>
            <td>{STATUS_LABEL[order.status]}</td>
            <td>
              <button
                type="button"
                className="link"
                disabled={order.status === "PENDING_CANCEL" || cancel.isPending}
                onClick={(e) => {
                  e.stopPropagation();
                  cancel.mutate(order.orderId);
                }}
              >
                {order.status === "PENDING_CANCEL" || cancel.isPending ? "Cancelling" : "Cancel"}
              </button>
            </td>
          </>
        ) : (
          <>
            <td className="numbers">{order.avgFillPriceCents === null ? "–" : formatCents(order.avgFillPriceCents)}</td>
            <td className={order.status === "REJECTED" ? "down" : ""} title={order.rejectText ?? undefined}>
              {STATUS_LABEL[order.status]}
            </td>
          </>
        )}
      </tr>
      {expanded && (
        <tr className="order-detail">
          <td colSpan={8}>
            <OrderDetail order={order} />
          </td>
        </tr>
      )}
    </>
  );
}

/** An order's history, placed through finished. Polled while it is still working. */
function OrderDetail({ order }: { order: Order }) {
  const detail = useOrder(order.orderId);
  return (
    <div className="order-detail-body">
      {order.rejectText && <p className="down">Rejected: {order.rejectText}</p>}
      <p className="muted">
        {order.orderType === "MARKET" ? "Market" : "Limit"} · {order.timeInForce} · id {order.orderId}
        {order.feeCents !== 0 && ` · ${order.feeCents < 0 ? "rebate" : "fees"} ${formatDollars(Math.abs(order.feeCents))}`}
      </p>
      {detail.isLoading ? (
        <p className="muted">Loading…</p>
      ) : detail.error ? (
        <p className="muted">Could not load its history.</p>
      ) : (
        <ol className="events">
          {detail.data?.events.map((event, i) => (
            <li key={i}>
              <span className="numbers muted">{orderTime(event.at)}</span>
              <span>{eventText(event)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
