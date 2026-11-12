# broker-web — Milestone 8

**The client.** A static bundle in the browser. It talks to two services and joins their
data itself, so neither service depends on the other: position P&L is backend positions
multiplied by market-data prices.

Status: **done** (the layout editor is planned for later) · depends on: backend (M6), market-data (M7)

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
2. **Layout:** each style's default layout, as data (`layout/layouts.ts`): which panels,
   and where each sits on a 12-column grid. See "Layouts as data" below.
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

- [x] Tokens for light and dark, and for Pro, Active and Calm
- [x] The mode and style settings, saved and restored; mode follows the system until chosen
- [x] A layout per style
- [x] Every later section checked in all six combinations, at desktop and phone width

Built: `theme/tokens.css` (colours per mode; type, spacing, shape and a few colours per
style), `layout/layouts.ts` (each style's default layout as data, and `validateLayout`),
`theme/layout.css` (draws any layout), `theme/theme.ts` (the settings, saved, following
the system until chosen), `Shell` and `Panel`, and a `Segmented` control. An inline script in `index.html`
applies the saved settings before the first paint, so a reload never flashes the wrong
colours. Checked in all six combinations at desktop and phone width, with stand-in panels:
no sideways overflow anywhere, and the settings survive a reload.

Found while checking: in Calm, and at phone width, panels collapsed to their headings. A
panel body scrolls inside a fixed-height grid (Pro and Active on a desktop), but the same
rule let it shrink to nothing where rows size to their content. That rule now applies only
to the fixed-height layouts.

### Layouts as data, for the layout editor to come

Users will be able to drag, resize and add panels later, so layouts are data from the
start, in the shape grid-based drag-and-drop editors use (react-grid-layout and similar):

- A **panel** is an instance, `{ id, type, props? }`: two charts on different symbols are
  two panels of one type.
- Its **placement** is `{ id, x, y, w, h }` on a 12-column grid. Dragging changes x and y,
  resizing changes w and h, adding appends a panel and a placement.
- The **phone** order is a list of ids; a panel left off it is not shown on a phone.
- **`fit`** is `screen` (the grid fills the window and panels scroll inside themselves:
  Pro, Active) or `flow` (rows size to content and the page scrolls: Calm).
- **`validateLayout`** reports overlaps, placements off the grid, duplicate ids and
  panels with no place, so a saved layout can be checked before it is drawn.

`Shell` draws whatever layout it is given: each panel's place goes in as CSS variables,
and `layout.css` turns them into grid positions on a desktop and one column on a phone. A
default and a layout the user arranged are drawn the same way.

The layout editor itself, later:
- [ ] Save a user's layout per style, with the account (a backend table, like the
      watchlist); on load, a layout that fails `validateLayout` falls back to the default
- [ ] An edit mode: drag to move, drag a corner to resize, add a panel from a list,
      remove one, reset to the default
- [ ] Per-panel settings through `props` (a chart's symbol and interval)

### 5. Sections

Each one a container and a view, built in the Pro style first.

- [x] **Sign in / sign up**
- [x] **App shell:** top bar, the layout grid, connection status (backend `/status`,
      market data `/health`, the live socket)
- [x] **Symbol search and quote header:** pick a symbol; last price, change on the day,
      bid and ask, volume
Step 5a done: sign in and sign up (the backend's own message on a refusal); the top bar with
symbol search (ticker or company name, by keyboard or mouse, remembered for next time), the
quote (last, change since the previous business day's close, bid, ask, today's volume, greyed
when the feed cannot vouch for it), and connection status for the broker, its exchange link
and prices. Sections not yet built say which step brings them. Checked against the full
stack: a wrong login, a sign-up, the quote updating live, search by name, the exchange and
market-data killed (both dots red, quote greyed) and restarted (back without a reload), and
Pro, Active and Calm at desktop and phone width. Vite now pre-bundles React and TanStack
Query: discovering one mid-session made it re-bundle and briefly load two copies of React.

- [x] **Watchlist:** starred symbols with last price, change and a sparkline; star and unstar
- [x] **Chart:** candles and volume, interval picker (1m, 5m, 1h, 1d), the current candle
      updated by live trades, colours taken from the tokens
- [x] **Order book:** 10 levels a side, spread, greyed out while stale
- [x] **Time and sales:** recent prints for the symbol
Step 5b done. The watchlist shows each starred symbol's last price, change since the
previous close and a sparkline of today (5m closes, with the previous close as a dashed
line); click a row to look at it, and star or unstar from the quote in the top bar or the
row. The chart (lightweight-charts 5.2.1) draws candles with volume underneath, times in
the browser's zone, colours re-read from the tokens on every mode or style change, and the
interval is remembered. The book shows ten levels a side with running totals as depth
bars, the mid and the spread, and keeps the last levels, greyed with a "Stale" badge, when
the feed cannot vouch for them. Time and sales colours each print by the side that took
liquidity. 10 new unit tests (37 in all). Checked against the full stack in Pro, Active
and Calm, light and dark, at desktop and phone width: no sideways overflow anywhere.

Decisions:
- **The chart is fed changes, not redrawn.** `foldTrade` keeps every untouched bar the
  same object, so "only the tail changed" is an identity check (`chart/updates.ts`); a live
  trade becomes `update()` on one or two bars, anything else (a refetch, another symbol or
  interval) replaces the data. A refetch keeps where you scrolled; a new symbol or
  interval jumps to the latest bars.
- **Time and sales needed history.** `/live` only sends trades from the moment a browser
  subscribes, so a symbol you just picked had an empty tape. market-data gained
  `GET /trades?symbol=&limit=` (newest first, at most 200), and the web joins it with live
  prints by trade id (`market/tape.ts`).
- **Sections adapt to their panel, not the window.** Panel bodies are CSS containers, so
  Pro's narrow watchlist drops the sparkline while Calm's wide one shows it, whatever the
  window size. A panel layout the user resizes later gets this for free.

- [x] **Order ticket:** buy or sell, market or limit, quantity and price, estimated cost
      against buying power. Tick, lot and band checks as hints only; the server's
      rejection reason shown when it refuses. A fresh `clientOrderId` per submit.
- [x] **Positions:** quantity (settled and unsettled), average cost, market value, P&L
- [x] **Orders:** working (with cancel) and history (with rejection reasons)
- [x] **Order detail:** an order's events, placed through filled
Step 5c done. The ticket is its own always-visible section: buy or sell, market or limit,
shares (default 1), a limit price, and time in force under "More" (default Day). It shows
the estimate (at the ask or bid for a market order, at the limit otherwise) and, for a
market buy, the larger amount held back at the price band's ceiling. Hints for lot, tick,
band, buying power and shares available never block sending. Review opens a confirmation
(the browser's own `<dialog>`); Place order sends it with a new `clientOrderId`, and the
ticket then follows that order until it finishes ("filled at 42.03", or the server's
reason). Clicking a level in the order book sets the ticket's limit price. The activity
panel has Positions, Open orders and History as tabs: positions valued at the live last
trade, else the last stored trade, else the previous close; orders with cancel, a "this
symbol only" filter, and rows that expand into the order's events. 12 new unit tests (49
in all). Checked against the full stack: a market buy filled and showed up as a position
with its cost and P&L; a limit sell priced from the book rested, was cancelled, and its
four events showed in history; a sell of more than was held was refused with the server's
reason. All six style combinations at desktop and phone width, no sideways overflow.

Decisions:
- **The `positions` panel became `activity`**, with tabs. Pro's bottom strip is too narrow
  for positions and orders side by side, and each tab is its own component, so the layout
  editor can still give one a panel of its own.
- **Active's layout changed** for the full ticket: the ticket and the book share the right
  column, and time and sales sits under the watchlist. Pro's ticket gained a row.
- **A confirmation for every order**, by request. One ticket for every style for now; a
  simpler Calm ticket is step 6's to decide.
- **The draft is shared UI state** (`ticket/draft.ts`), like the selected symbol, so other
  sections can fill it in. Not saved: a reload starts a fresh ticket. Changing symbol
  clears the price.
- **Estimates leave out fees.** The web does not know the venue's fees, so "held back"
  shows the price part and says "plus fees" where it matters (buying power).
- **Order history is the backend's latest 100**, with no paging, until that is not enough.

- [x] **Account summary:** cash, buying power, reserved, total value, P&L
- [x] **Notifications:** a toast on fill, rejection or lost connection
- [x] **Add funds**
- [x] **Settings:** mode, style, default order quantity
- [x] Empty, loading and error states for every section
Step 5d done. The activity panel opens with the account: total value, cash, buying power,
cash held for working orders, unrealized and realized P&L, and an Add funds button
(presets or any amount; simulated cash, there at once). Toasts announce fills (partial
and complete), rejections, expiries, cancellations, a deposit, and any connection lost or
regained; the first look at the orders is only a baseline. Settings (top bar) holds the
style, the mode and the ticket's default quantity, all saved in this browser; the theme
switcher moved there. The empty, loading and error pass added "pick a symbol" to the book
and tape, a retry for the symbol list (with a note in the top bar while it fails), and an
error boundary per panel, so one section failing cannot blank the screen. 9 new unit
tests (58 in all). Checked against the full stack: a deposit and a market buy, each with
its toast, the summary and positions following; settings applied at once and survived a
reload; all six combinations at desktop and phone width, dialogs included.

Decisions:
- **P&L is unrealized and realized, not "for the day".** A day's P&L needs the account's
  value at the start of the day, which nothing records yet; holdings times the change
  since the previous close would be wrong for anything bought today. A backend snapshot
  at the day roll would make it exact, later.
- **The summary lives at the top of the activity panel**, beside positions, rather than a
  panel of its own, so every style shows it without a layout change.
- **Prices for valuation come from one hook** (`useLastPrices`), so the summary and the
  positions table can never disagree.
- **A deposit is idempotent per opening of the dialog**: its reference is made when the
  dialog opens, so a double click or retry posts once.
- **Connection toasts are on transitions only**, "connecting" is neither up nor down, and
  nothing is announced on the first look.
- Found for step 6: on a phone in Calm, the chart's title is cut short by the interval
  buttons.

### 6. More styles

- [x] **Active:** tokens, layout, and any view variants it needs
- [x] **Calm:** tokens, layout, and any view variants it needs

Done. View variants are a per-style table (`theme/variants.ts`) that a section's view reads;
containers never do, so every variant shows the same data and does the same things.

| | Pro | Active | Calm |
|---|---|---|---|
| Ticket | `form`: every field at once | `quick`: a quantity stepper, then Sell at the bid and Buy at the ask, each opening the confirmation | `simple`: Buy or Sell, a shares stepper, the estimate large, Review; limit price and time in force under "More options" |
| Positions | `table` | `table` | `list`: one line each, value and P&L, no sideways scrolling on a phone |

Also: the chart's title is just the symbol (the picker already says the interval), which
fixed it being cut to "ACM..." on a phone in Calm; Calm's plain buttons get a soft fill,
since Calm draws no borders. 4 new unit tests (62 in all). Checked in the browser: Active's
stepper and Sell button opening "Sell 2 ACME at market"; Calm's simple ticket and position
list; all six combinations at phone width with no sideways overflow and no title cut short.
Found while checking: the Calm button fill first outranked the buy and sell colours, so
Review showed grey; it now applies to plain buttons only.

### Chart: more dynamic

Done. A legend over the chart's top left names the symbol and interval ("ACME · 1m") and
shows the open, high, low, close, volume and change (close against open, green or red) of
the candle under the cursor, or the latest one when the cursor is elsewhere, so it moves
with live trades. The crosshair follows the cursor and labels the price on the right axis
and the time on the bottom one. Under the chart, range buttons (1H, 6H, 1D, 5D, 1M, 1Y,
All) set how much time it shows, ending at the latest candle; clicking the chosen one again
goes back to it after zooming or scrolling. Wheel, drag and pinch zoom and pan are the
library's own and still work. The range is remembered like the interval. 10 new unit tests
(72 in all). Checked in the browser against synthetic history and trades (the stack was
down): hovering, every range, interval and range changing each other, wheel zoom kept
through live trades, a range click resetting it, and all six combinations at phone width
with no sideways overflow.

Decisions:
- **Range and interval choose each other** (`chart/range.ts`). market-data returns at most
  1000 bars, so 1m reaches back under 17 hours, and an hour of daily candles is not one
  candle. A range fits an interval when it takes between 5 and 1000 candles. Picking a
  range keeps the interval if it fits, else takes the finest that does (1D on 1m becomes
  5m); picking an interval keeps the range if it fits, else takes the nearest that does
  (1m with 1D becomes 6H). "All" fits anything: as far back as 1000 candles reach.
- **Enough history for the range.** `useHistory` takes a bar count: twice the range, at
  least 300, at most 1000. Asking for more of the same symbol and interval keeps showing the
  bars already there until the longer list lands, so the chart never blanks.
- **Ranges are framed by time, drawn by index.** The chart spaces candles evenly with no
  gaps for quiet minutes, so a range starts at the first candle inside it, and shows at least
  10 candles, so a quiet hour is not two giant ones.
- **The view is framed once per choice.** A new symbol, interval, range or range click
  frames it; a refetch or a live trade never does, so zooming and scrolling stay put.
- **Prices in the legend come from cents** (`chart/legend.ts`, `formatCents`); the series
  stays in dollars for drawing only.

Later: the highest high and lowest low among the candles in view are marked on the chart,
"H 101.25" above that candle and "L 98.10" below, as most trading charts do. They move as
you zoom or scroll, with a new range or interval, and when a live trade sets a new high or
low. Drawn with the library's own series markers (`createSeriesMarkers`) and worked out
again on its visible range event (`subscribeVisibleLogicalRangeChange`); which candles
count is a pure function (`chart/extremes.ts`, 5 unit tests). Only candles whose centre is
in view count, and on a tie the earlier one wins. The marks use the muted text colour, so
they read in every style and mode.

### After M8

- **Defaults:** Active is the style a first visit gets (`DEFAULT_STYLE` in `theme/theme.ts`,
  repeated in `index.html`'s pre-paint script). The app is called "Trading Platform".
- **Active's layout:** time and sales moved under the order book in the right column (ticket
  5 rows, book 4, tape 3); the watchlist runs the full height of the left column, and the
  activity panel (positions, orders) sits under the chart. On a phone:
  chart, ticket, book, time and sales, then activity and the watchlist.
- **Favicon:** `public/favicon.svg`, three candles (one down, two rising) on a dark tile,
  kept to a few thick shapes so it stays readable at 16px on light and dark tab bars.
- **Starting watchlist:** a new account now starts with every active symbol, up to 10
  (`DEFAULT_WATCHLIST_SIZE` in the backend's `watchlist.ts`; it was the first 5). Ten are
  listed today, so the whole market is starred. Accounts that already exist keep their lists.
- **Top bar:** on screens 1280px and wider, Pro and Active keep it to one line; when space is
  short the company's full name is cut with an ellipsis. Renaming to "Trading Platform"
  had made Active's bar 9px too wide at 1440px, pushing Settings and Sign out to a second
  line. Narrower screens still wrap, and Calm keeps its stacked header.
- **Positions tab:** no count in its name, and a **Book cost** column: what the shares still
  held cost, fees included (`costBasisCents`, the figure P&L is measured against). In
  Calm's list it is on the line under the symbol. Open orders keeps its count, since that one is
  worth noticing.

## Done when

Click "Buy 100" in the browser, watch the order fill in the blotter, the book move, and
holdings update with P&L, in every style and mode, at desktop and phone width.

**Met.** Market buys of 100 and 25 placed from the ticket (in Pro) filled, showed in the
blotter and as a toast, and updated holdings, cost and P&L live, with the book and tape
moving. Active and Calm were checked up to the confirmation; every style shares the same
containers, so only the views differ. All six combinations were checked at desktop and phone
width.
