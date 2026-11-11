# broker-web — Milestone 8

**The client.** Deliberately minimal and deliberately last — the UI is the least
interesting part of this project and the easiest to change.

Status: **not started** · depends on: backend (M6), market-data (M7)

## Inputs / outputs

| | |
|---|---|
| **In** | The user |
| **Out** | HTTP to `backend` (auth, orders, positions). HTTP + WebSocket to `market-data` (prices, history). |

It talks to **two services and joins them itself** — position P&L is backend positions
multiplied by market-data prices. That is what keeps the backend free of any market-data
dependency.

## Checklist

- [ ] Login
- [ ] Symbol picker (list from `backend`)
- [ ] Price chart from `market-data` history, with an interval selector
- [ ] Live price and depth ladder over the `market-data` WebSocket
- [ ] Holdings, with P&L joined client-side
- [ ] Order blotter — working and completed, with rejection reasons shown
- [ ] Order ticket: market or limit, buy or sell
- [ ] Client-side validation mirroring the server's (tick size, lot size) — as a hint only;
      the server is still the authority
- [ ] Show that a fill is unsettled, so T+1 is visible when it arrives post-MVP

## Done when

Click "buy 100" in the browser, watch the book move and holdings update.
