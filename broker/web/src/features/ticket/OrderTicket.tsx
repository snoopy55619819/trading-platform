// The order ticket: always on screen, for the selected symbol. Buy or sell, market or
// limit, a quantity in shares, and (under "More") how long it lasts. Review opens a
// confirmation; only Place order there sends it, with a fresh clientOrderId each time.
//
// Three views of the same ticket, one per style (theme/variants.ts): the full form (Pro),
// quick Buy and Sell buttons (Active), and a simple one-question-at-a-time form (Calm).
//
// What is typed lives in the draft store (draft.ts), so the order book can set the price.

import { type FormEvent, type ReactNode, useEffect, useState } from "react";

import { ApiError, type Order, type Security, type TimeInForce } from "../../api/backend.ts";
import { formatCents, formatDollars } from "../../money.ts";
import { bucketStart } from "../../market/candles.ts";
import { useHistory, useMarket } from "../../market/hooks.ts";
import { newClientOrderId, useOrder, useOrders, usePlaceOrder, usePositions } from "../../query/hooks.ts";
import { ConfirmDialog } from "../../ui/Dialog.tsx";
import { Panel } from "../../ui/Shell.tsx";
import { Segmented, Stepper } from "../../ui/controls.tsx";
import { type Variants, useVariants } from "../../theme/variants.ts";
import { STATUS_LABEL, availableToSell, sharesOwned } from "../activity/orders.ts";
import { quoteFrom } from "../header/quote.ts";
import { type Draft, updateDraft, useDraft } from "./draft.ts";
import { type TicketCheck, checkTicket, ownedText } from "./ticket.ts";
import "./ticket.css";

/** The last submit: an order to follow, or why it was not placed. */
type Outcome = { ok: true; orderId: string; summary: string } | { ok: false; text: string };

export function OrderTicket({ symbol, security }: { symbol: string | undefined; security: Security | undefined }) {
  const draft = useDraft();
  const variants = useVariants();
  const market = useMarket(symbol);
  const daily = useHistory(symbol, "1d");
  const positions = usePositions();
  const orders = useOrders();
  const place = usePlaceOrder();
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | undefined>(undefined);

  // A price typed for one symbol means nothing for another.
  useEffect(() => {
    updateDraft({ priceText: "" });
    setOutcome(undefined);
  }, [symbol]);

  if (!symbol) {
    return (
      <Panel title="Order ticket">
        <p className="empty">Pick a symbol to trade.</p>
      </Panel>
    );
  }

  const quote = quoteFrom(market, daily.bars, bucketStart(Date.now(), "1d"));
  const available =
    positions.data && orders.data ? availableToSell(positions.data.holdings, orders.data, symbol) : undefined;
  const check = checkTicket(symbol, draft, {
    security,
    bestBidCents: quote.bidCents,
    bestAskCents: quote.askCents,
    lastCents: quote.lastCents,
    buyingPowerCents: positions.data?.buyingPowerCents,
    availableToSell: available,
  });

  const send = () => {
    if (!check.order) return;
    place.mutate(
      { ...check.order, clientOrderId: newClientOrderId() },
      {
        onSuccess: (order: Order) => setOutcome({ ok: true, orderId: order.orderId, summary: check.summary }),
        onError: (error) =>
          setOutcome({ ok: false, text: error instanceof ApiError ? `Refused: ${error.message}` : `Not sent: ${error.message}` }),
        onSettled: () => setConfirming(false),
      },
    );
  };

  return (
    <TicketView
      symbol={symbol}
      variant={variants.ticket}
      draft={draft}
      bidCents={quote.bidCents}
      askCents={quote.askCents}
      lotSize={security?.lotSize ?? 1}
      check={check}
      buyingPowerCents={positions.data?.buyingPowerCents}
      owned={positions.data ? sharesOwned(positions.data.holdings, symbol) : undefined}
      available={available}
      outcome={outcome}
      onChange={(change) => {
        updateDraft(change);
        setOutcome(undefined);
      }}
      onReview={() => setConfirming(true)}
      confirm={
        <ConfirmDialog
          open={confirming}
          title="Confirm order"
          confirmLabel="Place order"
          confirmClass={draft.side === "BUY" ? "buy" : "sell"}
          busy={place.isPending}
          onConfirm={send}
          onCancel={() => setConfirming(false)}
        >
          <p className="confirm-summary">{check.summary}</p>
          <CostLines check={check} draft={draft} />
          {check.hints.map((hint) => (
            <p key={hint} className="hint">
              {hint}
            </p>
          ))}
        </ConfirmDialog>
      }
    />
  );
}

const TIF_OPTIONS: { value: TimeInForce; label: string }[] = [
  { value: "DAY", label: "Day: until the close" },
  { value: "GTC", label: "Good till cancelled" },
  { value: "IOC", label: "Immediate or cancel" },
  { value: "FOK", label: "Fill or kill" },
];

/** The estimate, and for a buy the cash held back while it works when that is more. */
function CostLines({ check, draft }: { check: TicketCheck; draft: Draft }) {
  return (
    <dl className="ticket-costs">
      <div>
        <dt>{draft.orderType === "MARKET" ? `Estimated, at the ${draft.side === "BUY" ? "ask" : "bid"}` : "Estimated"}</dt>
        <dd className="numbers">{check.estimateCents === undefined ? "–" : formatDollars(check.estimateCents)}</dd>
      </div>
      {check.reserveCents !== undefined && check.estimateCents !== undefined && check.reserveCents > check.estimateCents && (
        <div>
          <dt>Held back until filled</dt>
          <dd className="numbers">up to {formatDollars(check.reserveCents)}</dd>
        </div>
      )}
    </dl>
  );
}

export function TicketView({
  symbol,
  variant,
  draft,
  check,
  bidCents,
  askCents,
  lotSize,
  buyingPowerCents,
  owned,
  available,
  outcome,
  onChange,
  onReview,
  confirm,
}: {
  symbol: string;
  variant: Variants["ticket"];
  draft: Draft;
  check: TicketCheck;
  bidCents: number | undefined;
  askCents: number | undefined;
  lotSize: number;
  buyingPowerCents: number | undefined;
  /** Shares of this symbol held, and how many of them are not already on working sells. */
  owned: number | undefined;
  available: number | undefined;
  outcome: Outcome | undefined;
  onChange: (change: Partial<Draft>) => void;
  onReview: () => void;
  confirm: ReactNode;
}) {
  const buy = draft.side === "BUY";
  const limit = draft.orderType === "LIMIT";

  const side = (
    <Segmented
      label="Side"
      options={[
        { value: "BUY", label: "Buy" },
        { value: "SELL", label: "Sell" },
      ]}
      value={draft.side}
      onChange={(side) => onChange({ side })}
    />
  );
  const orderType = (
    <Segmented
      label="Order type"
      options={[
        { value: "MARKET", label: "Market" },
        { value: "LIMIT", label: "Limit" },
      ]}
      value={draft.orderType}
      onChange={(orderType) => onChange({ orderType })}
    />
  );
  const shares =
    variant === "form" ? (
      <label className="field">
        Shares
        <input
          className="input numbers"
          inputMode="numeric"
          autoComplete="off"
          value={draft.qtyText}
          onChange={(e) => onChange({ qtyText: e.target.value })}
        />
      </label>
    ) : (
      <div className="field">
        Shares
        <Stepper label="Shares" value={draft.qtyText} step={lotSize} onChange={(qtyText) => onChange({ qtyText })} />
      </div>
    );
  const price = limit ? (
    <label className="field">
      Limit price
      <input
        className="input numbers"
        inputMode="decimal"
        autoComplete="off"
        placeholder="0.00"
        value={draft.priceText}
        onChange={(e) => onChange({ priceText: e.target.value })}
      />
    </label>
  ) : (
    // The form keeps the price box for a market order, disabled, so Shares does not
    // stretch across the whole ticket and nothing jumps when switching type. It shows
    // "Market" without touching the draft, so a typed limit price is kept for later
    // and never sent with a market order.
    variant === "form" && (
      <label className="field">
        Limit price
        <input className="input numbers" value="Market" disabled readOnly />
      </label>
    )
  );
  const timeInForce = (
    <label className="field">
      Time in force
      <select
        className="input select"
        value={draft.timeInForce}
        onChange={(e) => onChange({ timeInForce: e.target.value as TimeInForce })}
      >
        {TIF_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
  const findings = [...check.problems, ...check.hints].map((text) => (
    <p key={text} className="hint">
      {text}
    </p>
  ));
  const outcomeLine =
    outcome &&
    (outcome.ok ? (
      <PlacedOrder orderId={outcome.orderId} summary={outcome.summary} />
    ) : (
      <p className="ticket-outcome refused" role="status">
        {outcome.text}
      </p>
    ));
  const power = (
    <dl className="ticket-costs">
      <div>
        <dt>Buying power</dt>
        <dd className="numbers">{buyingPowerCents === undefined ? "–" : formatDollars(buyingPowerCents)}</dd>
      </div>
      <div>
        <dt>Shares owned</dt>
        <dd className="numbers">
          {owned === undefined || available === undefined ? (
            "–"
          ) : (!buy || variant === "quick") && available > 0 ? (
            // Selling everything that is free to sell is one click. The quick ticket picks
            // its side last (the Buy and Sell buttons), so there it is always offered.
            <button
              type="button"
              className="link numbers"
              title={`Sell all ${available.toLocaleString("en-US")} available`}
              onClick={() => onChange({ qtyText: String(available) })}
            >
              {ownedText(owned, available)}
            </button>
          ) : (
            ownedText(owned, available)
          )}
        </dd>
      </div>
    </dl>
  );
  // Whichever variant, Enter in a field reviews the order as it stands.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (check.order) onReview();
  };

  if (variant === "quick") {
    // Quantity first, then one press on the side you want: it opens the confirmation.
    const press = (s: Draft["side"]) => {
      onChange({ side: s });
      onReview();
    };
    const at = (cents: number | undefined) => (limit ? "" : cents === undefined ? "" : ` ${formatCents(cents)}`);
    return (
      <Panel title={`Trade ${symbol}`}>
        <form className="ticket" onSubmit={submit}>
          {orderType}
          <div className="ticket-fields">
            {shares}
            {price}
          </div>
          <div className="quick-sides">
            <button type="button" className="button sell quick" disabled={!check.order} onClick={() => press("SELL")}>
              <span>Sell</span>
              <span className="numbers">{limit ? "at limit" : `bid${at(bidCents)}`}</span>
            </button>
            <button type="button" className="button buy quick" disabled={!check.order} onClick={() => press("BUY")}>
              <span>Buy</span>
              <span className="numbers">{limit ? "at limit" : `ask${at(askCents)}`}</span>
            </button>
          </div>
          {power}
          {findings}
          <details className="ticket-more" open={draft.timeInForce !== "DAY" || undefined}>
            <summary>More</summary>
            {timeInForce}
          </details>
          {outcomeLine}
        </form>
        {confirm}
      </Panel>
    );
  }

  if (variant === "simple") {
    // One question at a time: which way, how many, what it comes to. The rest is tucked away.
    return (
      <Panel title={`${buy ? "Buy" : "Sell"} ${symbol}`}>
        <form className="ticket simple" onSubmit={submit}>
          {side}
          {shares}
          <p className="simple-estimate">
            <span className="muted">{limit ? "Comes to" : "About"}</span>
            <span className="numbers">{check.estimateCents === undefined ? "–" : formatDollars(check.estimateCents)}</span>
          </p>
          {findings}
          <button type="submit" className={`button ${buy ? "buy" : "sell"}`} disabled={!check.order}>
            Review
          </button>
          {power}
          <details className="ticket-more" open={limit || draft.timeInForce !== "DAY" || undefined}>
            <summary>More options</summary>
            <div className="ticket-more-body">
              {orderType}
              {price}
              {timeInForce}
            </div>
          </details>
          {outcomeLine}
        </form>
        {confirm}
      </Panel>
    );
  }

  return (
    <Panel title={`Trade ${symbol}`}>
      <form className="ticket" onSubmit={submit}>
        {side}
        {orderType}
        <div className="ticket-fields">
          {shares}
          {price}
        </div>
        <details className="ticket-more" open={draft.timeInForce !== "DAY" || undefined}>
          <summary>More</summary>
          {timeInForce}
        </details>
        <CostLines check={check} draft={draft} />
        {power}
        {findings}
        <button type="submit" className={`button ${buy ? "buy" : "sell"}`} disabled={!check.order}>
          Review {buy ? "buy" : "sell"}
        </button>
        {outcomeLine}
      </form>
      {confirm}
    </Panel>
  );
}

/** The order just placed, followed until it finishes (useOrder polls while it works). */
function PlacedOrder({ orderId, summary }: { orderId: string; summary: string }) {
  const order = useOrder(orderId).data;
  let text = "sent";
  if (order) {
    const avg = order.avgFillPriceCents === null ? "" : ` at ${formatCents(order.avgFillPriceCents)}`;
    text =
      order.status === "FILLED"
        ? `filled${avg}`
        : order.status === "PARTIALLY_FILLED"
          ? `${order.filledQty.toLocaleString("en-US")} of ${order.qty.toLocaleString("en-US")} filled${avg}`
          : order.status === "REJECTED"
            ? `rejected: ${order.rejectText ?? order.rejectReason ?? "no reason given"}`
            : STATUS_LABEL[order.status].toLowerCase();
  }
  return (
    <p className={order?.status === "REJECTED" ? "ticket-outcome refused" : "ticket-outcome"} role="status">
      {summary}: {text}.
    </p>
  );
}
