// The account at a glance: what it is worth, what can be spent, and the profit so far.
// Sits at the top of the activity panel, with Add funds beside it.

import { formatDollars, formatSignedDollars } from "../../money.ts";
import type { AccountSummary } from "./summary.ts";
import "./account.css";

const money = (cents: number | undefined) => (cents === undefined ? "–" : formatDollars(cents));
const signed = (cents: number | undefined) => (cents === undefined ? "–" : formatSignedDollars(cents));
const tone = (cents: number | undefined) => (!cents ? "" : cents > 0 ? "up" : "down");

export function AccountSummaryView({ summary, onAddFunds }: { summary: AccountSummary; onAddFunds: () => void }) {
  return (
    <div className="account">
      <dl className="account-figures">
        <div className="account-total">
          <dt>Total value</dt>
          <dd className="numbers">{money(summary.totalCents)}</dd>
        </div>
        <div>
          <dt>Cash</dt>
          <dd className="numbers">{money(summary.cashCents)}</dd>
        </div>
        <div>
          <dt>Buying power</dt>
          <dd className="numbers">{money(summary.buyingPowerCents)}</dd>
        </div>
        {summary.reservedCents > 0 && (
          <div>
            <dt>Held for orders</dt>
            <dd className="numbers">{money(summary.reservedCents)}</dd>
          </div>
        )}
        <div>
          <dt>Unrealized P&amp;L</dt>
          <dd className={`numbers ${tone(summary.unrealizedCents)}`}>{signed(summary.unrealizedCents)}</dd>
        </div>
        <div>
          <dt>Realized P&amp;L</dt>
          <dd className={`numbers ${tone(summary.realizedCents)}`}>{signed(summary.realizedCents)}</dd>
        </div>
      </dl>
      <button type="button" className="button" onClick={onAddFunds}>
        Add funds
      </button>
    </div>
  );
}
