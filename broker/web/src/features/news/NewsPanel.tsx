// The news panel: the newswire's latest headlines (ADR 0006), for the selected symbol or for
// every symbol. A headline opens its story in place; the ticker beside it selects that
// symbol. Good news is marked green, bad news red; a major story is in bold. It shows the
// latest ten, and more on request, so it stays short in a layout that grows with content.

import { useState } from "react";

import type { NewsMessage } from "../../api/marketData.ts";
import { useNews } from "../../market/hooks.ts";
import { NEWS_SCOPES, type NewsScope, settingsStore, useSettings } from "../../settings.ts";
import { Segmented } from "../../ui/controls.tsx";
import { Panel } from "../../ui/Shell.tsx";
import "./news.css";

/** Headlines shown at first, and how many more each "Show more" adds. */
export const FIRST_SHOWN = 10;
const MORE = 20;

export function NewsPanel({ symbol, onSelect }: { symbol: string | undefined; onSelect: (symbol: string) => void }) {
  const { newsScope } = useSettings();
  const { news, isLoading, error } = useNews(newsScope === "symbol" ? symbol : undefined);
  const picker = (
    <Segmented<NewsScope>
      label="News for"
      // The selected ticker names the first choice: short enough for a narrow panel.
      options={NEWS_SCOPES.map((s) => ({ value: s, label: s === "all" ? "All" : (symbol ?? "Symbol") }))}
      value={newsScope}
      onChange={(scope) => settingsStore.update({ newsScope: scope })}
    />
  );
  if (newsScope === "symbol" && !symbol) {
    return (
      <Panel title="News" actions={picker}>
        <p className="empty">Pick a symbol.</p>
      </Panel>
    );
  }
  return (
    <Panel title="News" actions={picker}>
      <NewsView news={news} isLoading={isLoading} failed={error !== null && news.length === 0} onSelect={onSelect} />
    </Panel>
  );
}

export function NewsView({
  news,
  isLoading,
  failed,
  onSelect,
}: {
  news: readonly NewsMessage[];
  isLoading: boolean;
  failed: boolean;
  onSelect: (symbol: string) => void;
}) {
  const [open, setOpen] = useState<string>();
  const [shown, setShown] = useState(FIRST_SHOWN);
  if (isLoading) return <p className="empty">Loading…</p>;
  if (failed) return <p className="empty">Could not load the news.</p>;
  if (news.length === 0) return <p className="empty">No news yet.</p>;
  return (
    <ul className="news-list">
      {news.slice(0, shown).map((h) => {
        const expanded = open === h.id;
        const headlineClass = h.severity === "MAJOR" ? "news-headline major" : "news-headline";
        return (
          <li key={h.id} className="news-item">
            <div className="news-meta">
              <span className="numbers muted">{when(h.ts)}</span>
              <button type="button" className="news-symbol" onClick={() => onSelect(h.symbol)} title={`Show ${h.symbol}`}>
                {h.symbol}
              </button>
              <Tone tone={h.tone} />
            </div>
            {/* Only a headline with a story opens: ones stored before stories existed have none. */}
            {h.body ? (
              <button type="button" className={headlineClass} aria-expanded={expanded} onClick={() => setOpen(expanded ? undefined : h.id)}>
                {h.headline}
              </button>
            ) : (
              <p className={`${headlineClass} news-headline-only`}>{h.headline}</p>
            )}
            {expanded && h.body && <p className="news-body">{h.body}</p>}
          </li>
        );
      })}
      {news.length > shown && (
        <li className="news-item">
          <button type="button" className="button news-more" onClick={() => setShown(shown + MORE)}>
            Show more
          </button>
        </li>
      )}
    </ul>
  );
}

function Tone({ tone }: { tone: NewsMessage["tone"] }) {
  if (tone === "POSITIVE") return <span className="news-tone up" aria-label="good news">▲</span>;
  if (tone === "NEGATIVE") return <span className="news-tone down" aria-label="bad news">▼</span>;
  return <span className="news-tone muted" aria-label="neutral">•</span>;
}

/** "14:03" today, "12 Nov 14:03" before that, in the viewer's time zone. */
export function when(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hour12: false });
  if (date.toDateString() === now.toDateString()) return time;
  return `${date.toLocaleDateString(undefined, { day: "numeric", month: "short" })} ${time}`;
}
