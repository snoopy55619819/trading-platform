// What is worth a toast, worked out by comparing what the app saw last time with what it
// sees now. Pure, so it is tested directly. The first look is only a baseline: nobody
// wants a toast for every order already in the history when the page loads.

import type { Order } from "../../api/backend.ts";
import { formatCents } from "../../money.ts";
import type { Tone } from "../../ui/toasts.ts";
import type { Connections } from "../header/ConnectionStatus.tsx";

export interface Notice {
  tone: Tone;
  title: string;
  text?: string | undefined;
}

const describe = (o: Order) => `${o.side === "BUY" ? "Buy" : "Sell"} ${o.qty.toLocaleString("en-US")} ${o.symbol}`;

/** Fills, rejections, expiries and cancellations since the last poll. */
export function orderNotices(previous: readonly Order[] | undefined, next: readonly Order[]): Notice[] {
  if (!previous) return [];
  const before = new Map(previous.map((o) => [o.orderId, o]));
  const notices: Notice[] = [];
  for (const o of next) {
    const was = before.get(o.orderId);
    const filledBefore = was?.filledQty ?? 0;
    if (o.filledQty > filledBefore) {
      const verb = o.side === "BUY" ? "Bought" : "Sold";
      const avg = o.avgFillPriceCents === null ? "" : ` at ${formatCents(o.avgFillPriceCents)} average`;
      notices.push(
        o.filledQty === o.qty
          ? { tone: "good", title: `${verb} ${o.qty.toLocaleString("en-US")} ${o.symbol}`, text: `Filled${avg}.` }
          : {
              tone: "good",
              title: `${verb} ${(o.filledQty - filledBefore).toLocaleString("en-US")} ${o.symbol}`,
              text: `${o.filledQty.toLocaleString("en-US")} of ${o.qty.toLocaleString("en-US")} filled${avg}.`,
            },
      );
    }
    if (o.status === was?.status) continue;
    if (o.status === "REJECTED") {
      notices.push({ tone: "bad", title: `Rejected: ${describe(o)}`, text: o.rejectText ?? o.rejectReason ?? undefined });
    } else if (o.status === "EXPIRED" && was) {
      notices.push({ tone: "info", title: `Expired: ${describe(o)}`, text: `${o.filledQty.toLocaleString("en-US")} filled.` });
    } else if (o.status === "CANCELED" && was) {
      notices.push({ tone: "info", title: `Cancelled: ${describe(o)}`, text: o.filledQty ? `${o.filledQty.toLocaleString("en-US")} had filled.` : undefined });
    }
  }
  return notices;
}

const NAMES: Record<keyof Connections, string> = { backend: "the broker", exchange: "the exchange", prices: "live prices" };

/** A connection that went down, or came back. "Connecting" is neither. */
export function connectionNotices(previous: Connections | undefined, next: Connections): Notice[] {
  if (!previous) return [];
  const notices: Notice[] = [];
  for (const key of Object.keys(NAMES) as (keyof Connections)[]) {
    if (previous[key] !== "bad" && next[key] === "bad") {
      notices.push({
        tone: "bad",
        title: `Lost connection to ${NAMES[key]}`,
        text: key === "prices" ? "Prices are stale until it reconnects." : "Orders may not go through until it reconnects.",
      });
    } else if (previous[key] === "bad" && next[key] === "ok") {
      notices.push({ tone: "good", title: `Reconnected to ${NAMES[key]}` });
    }
  }
  return notices;
}
