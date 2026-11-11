// Watches orders and connections and raises a toast for anything worth knowing: a fill, a
// rejection, an expiry, a cancellation, a connection lost or regained. Draws nothing.

import { useEffect, useRef } from "react";

import type { Order } from "../../api/backend.ts";
import { useOrders } from "../../query/hooks.ts";
import { notify } from "../../ui/toasts.ts";
import { type Connections, useConnections } from "../header/ConnectionStatus.tsx";
import { connectionNotices, orderNotices } from "./notices.ts";

export function Notifier() {
  const orders = useOrders();
  const connections = useConnections();
  const seenOrders = useRef<Order[] | undefined>(undefined);
  const seenConnections = useRef<Connections | undefined>(undefined);

  useEffect(() => {
    if (!orders.data) return;
    orderNotices(seenOrders.current, orders.data).forEach(notify);
    seenOrders.current = orders.data;
  }, [orders.data]);

  const { backend, exchange, prices } = connections;
  useEffect(() => {
    const now = { backend, exchange, prices };
    connectionNotices(seenConnections.current, now).forEach(notify);
    seenConnections.current = now;
  }, [backend, exchange, prices]);

  return null;
}
