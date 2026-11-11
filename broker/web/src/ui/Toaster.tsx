// Draws the toasts, bottom right (bottom on a phone). Polite: a screen reader announces
// them without interrupting.

import { dismiss, useToasts } from "./toasts.ts";

export function Toaster() {
  const toasts = useToasts();
  return (
    <div className="toaster" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          <div className="toast-text">
            <strong>{t.title}</strong>
            {t.text && <span>{t.text}</span>}
          </div>
          <button type="button" className="toast-close" onClick={() => dismiss(t.id)} aria-label="Dismiss">
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
