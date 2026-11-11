// Settings: how the screen looks (style and mode) and the ticket's default quantity. All
// saved in this browser. Changes apply at once; there is nothing to save.

import { useEffect, useState } from "react";

import { useSettings, settingsStore } from "../../settings.ts";
import { ThemeSwitcher } from "../../theme/ThemeSwitcher.tsx";
import { Dialog } from "../../ui/Dialog.tsx";
import { parseQty } from "../ticket/ticket.ts";

export function SettingsDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const settings = useSettings();
  const [qtyText, setQtyText] = useState(String(settings.defaultQty));
  useEffect(() => {
    if (open) setQtyText(String(settingsStore.get().defaultQty));
  }, [open]);
  const qty = parseQty(qtyText);
  return (
    <Dialog
      open={open}
      title="Settings"
      onClose={onClose}
      actions={
        <button type="button" className="button primary" onClick={onClose}>
          Done
        </button>
      }
    >
      <div className="field">
        Look
        <ThemeSwitcher />
      </div>
      <label className="field">
        Default order quantity (shares)
        <input
          className="input numbers"
          inputMode="numeric"
          autoComplete="off"
          value={qtyText}
          onChange={(e) => {
            setQtyText(e.target.value);
            const next = parseQty(e.target.value);
            if (next !== undefined) settingsStore.update({ defaultQty: next });
          }}
        />
      </label>
      {qty === undefined && <p className="hint">Whole shares, more than 0. Keeping {settings.defaultQty}.</p>}
    </Dialog>
  );
}
