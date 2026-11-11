// The app: the sign-in screen until there is a session, then the trading screen drawn
// from the current style's layout. Each panel type maps to its section; sections not built
// yet say which step brings them.
//
// Every section gets the selected symbol from here. A panel with its own symbol in `props`
// (a second chart, once layouts can be edited) would pass that instead.

import { QueryClientProvider } from "@tanstack/react-query";

import type { Security } from "./api/backend.ts";
import { AuthScreen } from "./features/auth/AuthScreen.tsx";
import { OrderBook } from "./features/book/OrderBook.tsx";
import { ChartSection } from "./features/chart/ChartSection.tsx";
import { TopBar } from "./features/header/TopBar.tsx";
import { TimeAndSales } from "./features/tape/TimeAndSales.tsx";
import { Watchlist } from "./features/watchlist/Watchlist.tsx";
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

const COMING: Partial<Record<SectionType, { title: string; step: string }>> = {
  ticket: { title: "Order ticket", step: "5c" },
  positions: { title: "Positions", step: "5c" },
};

function Section({
  panel,
  symbols,
  selected,
}: {
  panel: PanelInstance;
  symbols: readonly Security[];
  selected: string | undefined;
}) {
  switch (panel.type) {
    case "watchlist":
      return <Watchlist symbols={symbols} selected={selected} onSelect={selectSymbol} />;
    case "chart":
      return <ChartSection symbol={selected} />;
    case "book":
      return <OrderBook symbol={selected} />;
    case "tape":
      return <TimeAndSales symbol={selected} />;
    default:
      return <Placeholder panel={panel} />;
  }
}

function Placeholder({ panel }: { panel: PanelInstance }) {
  const { title, step } = COMING[panel.type] ?? { title: panel.type, step: "a later step" };
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
      render={(panel) => <Section panel={panel} symbols={symbols.data ?? []} selected={selected} />}
    />
  );
}
