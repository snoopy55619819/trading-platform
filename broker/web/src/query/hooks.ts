// Backend state through TanStack Query: fetching, polling, and refreshing what an action
// changed. Components ask for data by hook and never call the backend client themselves.
//
// Polling: orders and positions every second while any order is working (so a fill shows
// up at once), every five seconds otherwise.

import { QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

import { ApiError, type Order, type PlaceOrder, WORKING_STATUSES, backend } from "../api/backend.ts";
import { session } from "../api/session.ts";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // A refusal (4xx) will not change by asking again; a network blip might.
      retry: (failures, error) => !(error instanceof ApiError && error.status < 500) && failures < 2,
      refetchOnWindowFocus: true,
    },
  },
});

// Signing out forgets everything that belonged to the account.
session.subscribe(() => {
  if (!session.token()) queryClient.clear();
});

const keys = {
  status: ["status"],
  symbols: ["symbols"],
  positions: ["positions"],
  orders: ["orders"],
  order: (id: string) => ["orders", id],
  watchlist: ["watchlist"],
} as const;

export const FAST_POLL_MS = 1000;
export const SLOW_POLL_MS = 5000;

/** How often to poll orders and positions, given the latest orders. */
export function pollInterval(orders: Order[] | undefined): number {
  return orders?.some((o) => WORKING_STATUSES.includes(o.status)) ? FAST_POLL_MS : SLOW_POLL_MS;
}

export function useSignedIn(): boolean {
  return useSyncExternalStore(session.subscribe, () => session.token() !== undefined);
}

export function useLogIn() {
  return useMutation({
    mutationFn: async ({ email, password }: { email: string; password: string }) => {
      const { token } = await backend.logIn(email, password);
      session.start(token);
    },
  });
}

/** `onOpened` runs once the new account is open and signed in: to welcome the user. */
export function useSignUp(onOpened?: () => void) {
  return useMutation({
    mutationFn: async ({ email, password, name }: { email: string; password: string; name: string }) => {
      await backend.signUp(email, password, name);
      const { token } = await backend.logIn(email, password);
      session.start(token);
      onOpened?.();
    },
  });
}

export function signOut(): void {
  session.end();
}

/** Whether the backend is connected to the exchange. Public; polled while the app is open. */
export function useStatus() {
  return useQuery({ queryKey: keys.status, queryFn: backend.status, refetchInterval: SLOW_POLL_MS });
}

/** What can be traded. Changes rarely: fetched once per session, retried until it loads. */
export function useSymbols() {
  return useQuery({
    queryKey: keys.symbols,
    queryFn: backend.symbols,
    staleTime: Infinity,
    refetchInterval: (query) => (query.state.status === "error" ? SLOW_POLL_MS : false),
  });
}

export function useOrders() {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: keys.orders,
    queryFn: backend.orders,
    enabled: signedIn,
    refetchInterval: (query) => pollInterval(query.state.data),
  });
}

export function usePositions() {
  const signedIn = useSignedIn();
  const client = useQueryClient();
  return useQuery({
    queryKey: keys.positions,
    queryFn: backend.positions,
    enabled: signedIn,
    refetchInterval: () => pollInterval(client.getQueryData<Order[]>(keys.orders)),
  });
}

export function useOrder(orderId: string | undefined) {
  const signedIn = useSignedIn();
  return useQuery({
    queryKey: keys.order(orderId ?? ""),
    queryFn: () => backend.order(orderId!),
    enabled: signedIn && orderId !== undefined,
    refetchInterval: (query) => (query.state.data && WORKING_STATUSES.includes(query.state.data.status) ? FAST_POLL_MS : false),
  });
}

export function useWatchlist() {
  const signedIn = useSignedIn();
  return useQuery({ queryKey: keys.watchlist, queryFn: backend.watchlist, enabled: signedIn });
}

/** Star or unstar a symbol. The server's answer is the new list. */
export function useToggleWatch() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ symbol, watched }: { symbol: string; watched: boolean }) =>
      watched ? backend.unwatch(symbol) : backend.watch(symbol),
    onSuccess: (symbols) => client.setQueryData(keys.watchlist, symbols),
  });
}

/** Everything an order can change: refreshed at once rather than at the next poll. */
function refreshAfterTrading(client: QueryClient): Promise<void> {
  return Promise.all([
    client.invalidateQueries({ queryKey: keys.orders }),
    client.invalidateQueries({ queryKey: keys.positions }),
  ]).then(() => {});
}

export function usePlaceOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (order: PlaceOrder) => backend.placeOrder(order),
    // A rejection is recorded too, so refresh either way.
    onSettled: () => refreshAfterTrading(client),
  });
}

export function useCancelOrder() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (orderId: string) => backend.cancelOrder(orderId),
    onSettled: () => refreshAfterTrading(client),
  });
}

export function useDeposit() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ amountCents, reference }: { amountCents: number; reference: string }) =>
      backend.deposit(amountCents, reference),
    onSuccess: () => client.invalidateQueries({ queryKey: keys.positions }),
  });
}

/** A new idempotency key for an order: retrying with the same one cannot place it twice. */
export function newClientOrderId(): string {
  return crypto.randomUUID().replaceAll("-", "");
}
