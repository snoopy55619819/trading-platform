// The app: the sign-in screen until there is a session, then the trading screen drawn
// from the current style's layout. Each panel type maps to its section; sections not built
// yet say which step brings them.

import { QueryClientProvider } from "@tanstack/react-query";

import { AuthScreen } from "./features/auth/AuthScreen.tsx";
import { TopBar } from "./features/header/TopBar.tsx";
import { DEFAULT_LAYOUTS, type PanelInstance, type SectionType } from "./layout/layouts.ts";
import { queryClient, useSignedIn, useSymbols, useWatchlist } from "./query/hooks.ts";
import { selectSymbol, useSelectedSymbol } from "./selection.ts";
import { useTheme } from "./theme/theme.ts";
import { Panel, Shell } from "./ui/Shell.tsx";

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <Root />
    </QueryClientProvider>
  );
}

function Root() {
  return useSignedIn() ? <TradingScreen /> : <AuthScreen />;
}

const COMING: Record<SectionType, { title: string; step: string }> = {
  watchlist: { title: "Watchlist", step: "5b" },
  chart: { title: "Chart", step: "5b" },
  book: { title: "Order book", step: "5b" },
  tape: { title: "Time and sales", step: "5b" },
  ticket: { title: "Order ticket", step: "5c" },
  positions: { title: "Positions", step: "5c" },
};

function Placeholder({ panel }: { panel: PanelInstance }) {
  const { title, step } = COMING[panel.type];
  return (
    <Panel title={title}>
      <p className="muted" style={{ margin: 0 }}>
        Arrives in step {step}.
      </p>
    </Panel>
  );
}

function TradingScreen() {
  const theme = useTheme();
  const symbols = useSymbols();
  const watchlist = useWatchlist();
  const listed = (symbols.data ?? []).map((s) => s.symbol);
  // Until one is chosen: the first on the watchlist, else the first listed.
  const selected = useSelectedSymbol(listed, watchlist.data?.[0] ?? listed[0]);
  return (
    <Shell
      layout={DEFAULT_LAYOUTS[theme.style]}
      header={<TopBar symbols={symbols.data ?? []} selected={selected} onSelect={selectSymbol} />}
      render={(panel) => <Placeholder panel={panel} />}
    />
  );
}
