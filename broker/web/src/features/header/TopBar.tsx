// The top bar: symbol search and quote, connection status, settings, sign out.
// Fixed chrome, outside the panel layout.

import { useState } from "react";

import type { Security } from "../../api/backend.ts";
import { signOut } from "../../query/hooks.ts";
import { SettingsDialog } from "../settings/SettingsDialog.tsx";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { QuoteHeader } from "./QuoteHeader.tsx";
import { SymbolSearch } from "./SymbolSearch.tsx";
import "./header.css";

export function TopBar({
  symbols,
  selected,
  onSelect,
  symbolsFailed = false,
}: {
  symbols: readonly Security[];
  selected: string | undefined;
  onSelect: (symbol: string) => void;
  /** The symbol list could not be loaded (it is being retried). */
  symbolsFailed?: boolean;
}) {
  const security = symbols.find((s) => s.symbol === selected);
  const [settingsOpen, setSettingsOpen] = useState(false);
  return (
    <div className="topbar">
      <span className="brand">Broker</span>
      <SymbolSearch symbols={symbols} selected={selected} onSelect={onSelect} />
      {selected && <QuoteHeader symbol={selected} name={security?.name} />}
      {symbolsFailed && symbols.length === 0 && <span className="hint">Could not load the symbol list. Retrying…</span>}
      <div className="topbar-end">
        <ConnectionStatus />
        <button type="button" className="button" onClick={() => setSettingsOpen(true)}>
          Settings
        </button>
        <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <button type="button" className="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
