// Modal dialogs, on the browser's own <dialog>: showModal() traps focus, makes the page
// behind inert, and Escape cancels, so none of that is written by hand. The parent owns
// whether it is open.

import { type ReactNode, useEffect, useId, useRef } from "react";

export function Dialog({
  open,
  title,
  children,
  actions,
  onClose,
  busy = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  /** The buttons along the bottom. */
  actions: ReactNode;
  onClose: () => void;
  /** While true, Escape does nothing (a request is in flight). */
  busy?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
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
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault(); // closed by the parent's state, not by the browser
        if (!busy) onClose();
      }}
    >
      {open && (
        <>
          <h2 id={titleId} className="dialog-title">
            {title}
          </h2>
          <div className="dialog-body">{children}</div>
          <div className="dialog-actions">{actions}</div>
        </>
      )}
    </dialog>
  );
}

/** Are you sure? Cancel, or the action named on the confirm button. */
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
  return (
    <Dialog
      open={open}
      title={title}
      busy={busy}
      onClose={onCancel}
      actions={
        <>
          <button type="button" className="button" onClick={onCancel} disabled={busy}>
            Cancel
          </button>
          <button type="button" className={`button ${confirmClass}`} onClick={onConfirm} disabled={busy} autoFocus>
            {busy ? "Sending…" : confirmLabel}
          </button>
        </>
      }
    >
      {children}
    </Dialog>
  );
}
