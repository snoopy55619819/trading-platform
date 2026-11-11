// The top bar: symbol search and quote, connection status, display settings, sign out.
// Fixed chrome, outside the panel layout.

import type { Security } from "../../api/backend.ts";
import { signOut } from "../../query/hooks.ts";
import { ThemeSwitcher } from "../../theme/ThemeSwitcher.tsx";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { QuoteHeader } from "./QuoteHeader.tsx";
import { SymbolSearch } from "./SymbolSearch.tsx";
import "./header.css";

export function TopBar({
  symbols,
  selected,
  onSelect,
}: {
  symbols: readonly Security[];
  selected: string | undefined;
  onSelect: (symbol: string) => void;
}) {
  const security = symbols.find((s) => s.symbol === selected);
  return (
    <div className="topbar">
      <span className="brand">Broker</span>
      <SymbolSearch symbols={symbols} selected={selected} onSelect={onSelect} />
      {selected && <QuoteHeader symbol={selected} name={security?.name} />}
      <div className="topbar-end">
        <ConnectionStatus />
        <ThemeSwitcher />
        <button type="button" className="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    </div>
  );
}
