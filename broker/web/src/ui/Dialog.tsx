// A modal confirmation, on the browser's own <dialog>: showModal() traps focus, makes the
// page behind inert, and Escape cancels, so none of that is written by hand.

import { type ReactNode, useEffect, useRef } from "react";

export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  confirmClass = "primary",
  busy = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** The confirm button's look: "primary", "buy" or "sell". */
  confirmClass?: string;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="dialog"
      aria-labelledby="dialog-title"
      onCancel={(event) => {
        event.preventDefault(); // closed by the parent's state, not by the browser
        if (!busy) onCancel();
      }}
    >
      <h2 id="dialog-title" className="dialog-title">
        {title}
      </h2>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" className="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
        <button type="button" className={`button ${confirmClass}`} onClick={onConfirm} disabled={busy} autoFocus>
          {busy ? "Sending…" : confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
