# broker-web — Milestone 8

**The client.** A static bundle in the browser. It talks to two services and joins their
data itself, so neither service depends on the other: position P&L is backend positions
multiplied by market-data prices.

Status: **planned** · depends on: backend (M6), market-data (M7)

## Inputs / outputs

| | |
|---|---|
| **In** | The user |
| **Out** | HTTP to `backend` (auth, orders, positions, watchlist, status). HTTP + WebSocket to `market-data` (history, live books and trades). |

## Stack

Vite + React + TypeScript, TanStack Query, lightweight-charts. Versions pinned exactly.

| State | Example | Handled by |
|---|---|---|
| Server state (backend) | positions, orders, symbols, watchlist | TanStack Query: polling, refetch after an order, 401 means signed out |
| Streaming state (market data) | books, trades, the live candle | a hand-written store read through `useSyncExternalStore`, one re-render per symbol that changed |
| UI state | selected symbol, interval, ticket fields | `useState` |

The one built artifact in the repo: Node services run TypeScript directly, but a browser
bundle is built by nature. `CLAUDE.md` gets a one-line exception.

## Styles: two independent settings

Every section uses the **same data, hooks and inputs** in every style. A style changes how it
looks and where it sits, never what it shows or does.

- **Mode:** `light` | `dark`. Defaults to the operating system's setting.
- **Style:** `pro` | `active` | `calm`. Inspired by kinds of app, not copied from any one:
  no product names, logos, signature colours or fonts.

| Style | Feel |
|---|---|
| **Pro** | chart-first, dense, small type, thin borders, everything visible at once |
| **Active** | data-dense panels, strong green and red, quick buy and sell |
| **Calm** | spacious, large type, one thing at a time, depth hidden by default |

Both are attributes on the root (`data-mode`, `data-style`) and are saved in `localStorage`.
A style changes things at three levels; use the cheapest that does the job:

1. **Tokens:** colours per mode; spacing, density, radius, type scale, font and border weight
   per style. CSS custom properties only: no component hard-codes a colour or a size.
2. **Layout:** a grid arrangement per style.
3. **View variants (rarely):** when CSS cannot express the difference, a section takes a
   `variant` from the style's config (for example the ticket as a full form, or as big Buy
   and Sell buttons with a quantity stepper).

Every section is a **container** (hooks, data, mutations, validation) and a **view** (props
only). Styles never touch containers.

## Checklist

Worked through one step at a time, in this order.

### 1. Backend prerequisites (`broker/backend`)

- [x] **CORS:** an explicit origin allowlist (`BROKER_WEB_ORIGIN`, default the Vite dev
      origin), with preflight answered properly. Never `*` for an authenticated API.
- [x] **Cost basis:** average cost per position from the `fills` table, on `GET /positions`
      as `avgCostCents` and the exact `costBasisCents`. Tests: buys, a partial sell, selling
      out, buying back in.
- [x] **Watchlist:** a `watchlist` table (account, symbol, position in the list),
      `GET /watchlist`, `PUT /watchlist/:symbol`, `DELETE /watchlist/:symbol`. New accounts
      start with a default list.
- [x] **Status:** `GET /status` with whether the FIX session to the exchange is logged on, so
      the browser can show a dead connection before an order is rejected for it.

Done. 7 new tests (34 in the backend): average cost through buys, a partial sell, selling
out to exactly zero and buying back, a rebate, and booked fills in booking order; the
watchlist's defaults, order and refusals; `/status`; and CORS over a real server. Also
checked in a real browser: a page on `localhost:5173` could sign up, read and edit its
watchlist and read positions with cost; the same page on `localhost:5174` was blocked.

Two details worth knowing:
- Cost basis includes fees (a rebate lowers it), and `realizedPnlCents` is the profit
  already taken by selling, after fees. Closed positions' realised profit is on
  `/positions` as `closedRealizedPnlCents`.
- `fills` gained `fill_seq`, the order fills reached the ledger: average cost depends on
  order, and two fills can share a millisecond.

### 2. Scaffold

- [x] Vite + React + TypeScript in `broker/web`, pinned versions, `pnpm dev`, `build`,
      `typecheck`, `test`
- [x] `CLAUDE.md`: the no-build-step exception for the browser bundle
- [x] Config: the backend and market-data URLs from environment, defaulting to localhost

Done. React 19.3.1, Vite 8.3.7, TypeScript 5.9.3, Vitest 5.1.0, all pinned exactly; the
dev server is fixed on port 5173 (`strictPort`), the origin the backend allows. A
placeholder page checks both services are reachable from the browser, which proved the
config and CORS together; the real app shell replaces it in step 5.

### 3. Data layer (no UI)

- [x] `api/backend.ts`: a typed client for every backend call; a 401 signs you out
- [x] `api/marketData.ts`: `fetchHistory`, and a `LiveFeed` that subscribes, reconnects and
      resubscribes
- [x] The market data store: books and recent trades per symbol; snapshots replaced, never
      mutated, so `useSyncExternalStore` stays stable. The live candle is folded from those
      trades by `useHistory` (`market/candles.ts`), since it depends on the chart's interval
- [x] TanStack Query hooks: symbols, positions, orders (every second while any order is
      working, every 5 otherwise), watchlist, status; placing or cancelling an order
      refetches orders and positions at once
- [x] `money.ts`: cents to display, and typed dollars ("42.10") to cents without a float
- [x] Unit tests for the store and `money.ts`

Done. 17 unit tests (money, the store, candle folding, the live feed's reconnect and
resubscribe, polling intervals, the backend client's errors and sign-out on 401), plus 2
integration tests run with `pnpm test:live` against the real exchange, simulator, backend
and market-data: sign up, fund, buy, see the holding with its cost; history; a live book
arriving in the store.

Decisions:
- **The session token lives in `sessionStorage`**: a reload stays signed in, a new tab
  asks again. A 401 on a signed-in request signs out and clears every cached query.
- **Refusals are not retried.** A 4xx will not change by asking again; a network error
  or 5xx is retried twice.
- **The live candle never double-counts.** Only trades after the history fetch are folded
  in; one printed just before it but not yet rolled up is missed until the next refetch
  (every minute), the lesser error.

### 4. Theme system

- [ ] Tokens for light and dark, and for Pro, Active and Calm
- [ ] The mode and style settings, saved and restored; mode follows the system until chosen
- [ ] A layout per style
- [ ] Every later section checked in all six combinations, at desktop and phone width

### 5. Sections

Each one a container and a view, built in the Pro style first.

- [ ] **Sign in / sign up**
- [ ] **App shell:** top bar, the layout grid, connection status (backend `/status`,
      market data `/health`, the live socket)
- [ ] **Symbol search and quote header:** pick a symbol; last price, change on the day,
      bid and ask, volume
- [ ] **Watchlist:** starred symbols with last price, change and a sparkline; star and unstar
- [ ] **Chart:** candles and volume, interval picker (1m, 5m, 1h, 1d), the current candle
      updated by live trades, colours taken from the tokens
- [ ] **Order book:** 10 levels a side, spread, greyed out while stale
- [ ] **Time and sales:** recent prints for the symbol
- [ ] **Order ticket:** buy or sell, market or limit, quantity and price, estimated cost
      against buying power. Tick, lot and band checks as hints only; the server's
      rejection reason shown when it refuses. A fresh `clientOrderId` per submit.
- [ ] **Positions:** quantity (settled and unsettled), average cost, market value, P&L
- [ ] **Orders:** working (with cancel) and history (with rejection reasons)
- [ ] **Order detail:** an order's events, placed through filled
- [ ] **Account summary:** cash, buying power, reserved, total value, P&L for the day
- [ ] **Notifications:** a toast on fill, rejection or lost connection
- [ ] **Add funds**
- [ ] **Settings:** mode, style, default order quantity
- [ ] Empty, loading and error states for every section

### 6. More styles

- [ ] **Active:** tokens, layout, and any view variants it needs
- [ ] **Calm:** tokens, layout, and any view variants it needs

## Done when

Click "Buy 100" in the browser, watch the order fill in the blotter, the book move, and
holdings update with P&L, in every style and mode, at desktop and phone width.
