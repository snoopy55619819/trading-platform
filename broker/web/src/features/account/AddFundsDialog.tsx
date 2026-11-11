// Add funds: cash into the account, standing in for a bank transfer. Each opening of the
// dialog gets its own reference, so a double click or a retry cannot deposit twice (the
// backend posts a reference once).

import { useEffect, useState } from "react";

import { formatCents, formatDollars, parseDollars } from "../../money.ts";
import { useDeposit } from "../../query/hooks.ts";
import { Dialog } from "../../ui/Dialog.tsx";

const PRESETS = [100_000, 1_000_000, 5_000_000]; // $1,000, $10,000, $50,000

export function AddFundsDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (cents: number) => void }) {
  const deposit = useDeposit();
  const [text, setText] = useState("");
  const [reference, setReference] = useState("");
  useEffect(() => {
    if (!open) return;
    setText("");
    setReference(crypto.randomUUID());
    deposit.reset();
  }, [open]); // only reopening resets the form; `deposit` changes on every render
  const cents = parseDollars(text);
  const valid = cents !== undefined && cents > 0;
  const submit = () => {
    if (!valid) return;
    deposit.mutate({ amountCents: cents, reference }, { onSuccess: () => onDone(cents) });
  };
  return (
    <Dialog
      open={open}
      title="Add funds"
      busy={deposit.isPending}
      onClose={onClose}
      actions={
        <>
          <button type="button" className="button" onClick={onClose} disabled={deposit.isPending}>
            Cancel
          </button>
          <button type="button" className="button primary" onClick={submit} disabled={!valid || deposit.isPending}>
            {deposit.isPending ? "Adding…" : valid ? `Add ${formatDollars(cents)}` : "Add"}
          </button>
        </>
      }
    >
      <p className="muted">Simulated cash: it arrives at once and settles immediately.</p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="field">
          Amount (dollars)
          <input
            className="input numbers"
            inputMode="decimal"
            autoComplete="off"
            placeholder="10,000.00"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
        </label>
      </form>
      <div className="presets">
        {PRESETS.map((p) => (
          <button key={p} type="button" className="button" onClick={() => setText(formatCents(p))}>
            {formatDollars(p)}
          </button>
        ))}
      </div>
      {text.trim() && !valid && <p className="hint">Dollars and cents, more than 0, like 2500 or 2,500.00.</p>}
      {deposit.error && <p className="down">Not added: {deposit.error.message}</p>}
    </Dialog>
  );
}
