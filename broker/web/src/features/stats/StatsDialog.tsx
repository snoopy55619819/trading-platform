// The platform's live stats (ADR 0016): a strip in the top bar, sized by style, and a dialog
// with every number, who reports it, what it means and, for the main ones, five minutes of
// trend. Everything is a total across the whole market: nothing names a participant.

import { useEffect, useRef, useSyncExternalStore } from "react";

import type { StatsPoint } from "../../api/marketData.ts";
import { usePlatformStats } from "../../market/hooks.ts";
import { recentAverage } from "../../market/stats.ts";
import { useStatus } from "../../query/hooks.ts";
import { useVariants } from "../../theme/variants.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { type TrendKey, formatStat, groups } from "./catalog.ts";
import "./stats.css";

let isOpen = false;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
export const statsDialog = {
  open(): void {
    isOpen = true;
    emit();
  },
  close(): void {
    isOpen = false;
    emit();
  },
};
function useStatsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => isOpen,
  );
}

/**
 * The top bar's strip: order updates and trades a second (averaged over five seconds, so
 * they can be read) and the typical answer time. Terminal adds market data updates; Calm
 * shows none. Opens the dialog.
 */
export function StatsStrip() {
  const { statsStrip } = useVariants();
  const { latest, history } = usePlatformStats();
  if (statsStrip === "none") return null;
  const venue = latest?.venue ?? null;
  const updates = recentAverage(history, "transactionsPerSec");
  const trades = recentAverage(history, "tradesPerSec");
  return (
    <button
      type="button"
      className="stats-strip"
      onClick={statsDialog.open}
      title="Live platform stats: what the whole system is handling right now"
    >
      <span className={`stats-dot ${venue ? "live" : ""}`} aria-hidden="true" />
      <span className="stats-item">
        <b>{formatStat("rate", updates)}</b> order updates
      </span>
      <span className="stats-item stats-more">
        <b>{formatStat("rate", trades)}</b> trades
      </span>
      {statsStrip === "full" && (
        <span className="stats-item stats-wide">
          <b>{formatStat("rate", venue?.feedMessagesPerSec ?? null)}</b> market data
        </span>
      )}
      <span className="stats-item stats-wide">
        <b>{formatStat("micros", venue?.answerP50Us ?? null)}</b> answers
      </span>
    </button>
  );
}

export function StatsDialog() {
  const open = useStatsOpen();
  return (
    <Dialog
      open={open}
      title="Live platform stats"
      wide
      onClose={statsDialog.close}
      actions={
        <button type="button" className="button primary" onClick={statsDialog.close}>
          Close
        </button>
      }
    >
      {open && <StatsView />}
    </Dialog>
  );
}

/** The dialog's contents. Exported for tests and for the guide. */
export function StatsView() {
  const { latest, history } = usePlatformStats();
  const { data: status } = useStatus();
  // Opening a dialog focuses its first button, Close, at the bottom of this long one, which
  // scrolls it to the end. Start at the top instead, once the dialog has opened.
  const top = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const frame = requestAnimationFrame(() => top.current?.closest("dialog")?.scrollTo(0, 0));
    return () => cancelAnimationFrame(frame);
  }, []);
  return (
    <div className="stats" ref={top}>
      <p className="stats-intro">
        What the whole system is handling right now, updated every second: the exchange, the service that sends you prices,
        and the broker that holds your account. Totals for everyone trading here, never anyone in particular.
        {latest && !latest.venue && " The exchange has not reported in the last few seconds."}
      </p>
      {groups(latest, status).map((group) => (
        <section key={group.title} className="stats-group">
          <h3>
            {group.title} <span className="muted">{group.source}</span>
          </h3>
          <dl>
            {group.stats.map((stat) => (
              <div key={stat.id} className="stats-row">
                <dt>{stat.label}</dt>
                <dd className="numbers">{formatStat(stat.format, stat.value)}</dd>
                <dd className="stats-trend">{stat.trend && <Sparkline points={history} field={stat.trend} />}</dd>
                <dd className="stats-about muted">{stat.about}</dd>
              </div>
            ))}
          </dl>
        </section>
      ))}
    </div>
  );
}

/** Five minutes of one number as a small line, scaled to its own range. No axes: the shape. */
export function Sparkline({ points, field }: { points: readonly StatsPoint[]; field: TrendKey }) {
  const values = points.map((p) => p[field]);
  const known = values.filter((v): v is number => v !== null);
  if (known.length < 2) return null;
  const max = Math.max(...known);
  const min = Math.min(...known, 0);
  const span = max - min || 1;
  const width = 120;
  const height = 24;
  const step = width / Math.max(1, values.length - 1);
  let path = "";
  values.forEach((v, i) => {
    if (v === null) return;
    const x = i * step;
    const y = height - ((v - min) / span) * height;
    path += `${path && values[i - 1] !== null ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)} `;
  });
  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path d={path.trim()} />
    </svg>
  );
}
