// The platform's live stats (ADR 0016): one number in the top bar, the system's throughput,
// and a short dialog with the rest. Each stat explains itself on hover or focus, so the
// dialog stays a page of numbers. Everything is a total across the whole market: nothing
// names a participant.

import { useId, useSyncExternalStore } from "react";

import { usePlatformStats } from "../../market/hooks.ts";
import { recentAverage } from "../../market/stats.ts";
import { useStatus } from "../../query/hooks.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { type Stat, formatStat, groups } from "./catalog.ts";
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
 * The top bar's one number: order updates a second across the whole system, averaged over
 * five seconds so it can be read. Opens the dialog.
 */
export function StatsStrip() {
  const { latest, history } = usePlatformStats();
  const throughput = recentAverage(history, "transactionsPerSec");
  return (
    <button type="button" className="stats-strip" onClick={statsDialog.open} title="Live platform stats">
      <span className={`stats-dot ${latest?.venue ? "live" : ""}`} aria-hidden="true" />
      <span className="stats-label">System throughput</span>
      <b>{formatStat("rate", throughput)}</b>
    </button>
  );
}

export function StatsDialog() {
  const open = useStatsOpen();
  return (
    <Dialog
      open={open}
      title="Live platform stats"
      onClose={statsDialog.close}
      actions={
        // Focus starts on Close, not on the first stat, so no description opens by itself.
        <button type="button" className="button primary" onClick={statsDialog.close} data-autofocus>
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
  const { latest } = usePlatformStats();
  const { data: status } = useStatus();
  return (
    <div className="stats">
      {latest && !latest.venue && <p className="muted">The exchange has not reported in the last few seconds.</p>}
      {groups(latest, status).map((group) => (
        <section key={group.title} className="stats-group">
          <h3>{group.title}</h3>
          <dl className="stats-tiles">
            {group.stats.map((stat) => (
              <StatTile key={stat.id} stat={stat} />
            ))}
          </dl>
        </section>
      ))}
      <p className="stats-hint muted">Updated every second. Hover over or tap a number to see what it means.</p>
    </div>
  );
}

/** A name and its value; what it means shows on hover, or on focus for keyboards and taps. */
function StatTile({ stat }: { stat: Stat }) {
  const id = useId();
  return (
    <div className="stats-tile" tabIndex={0} aria-describedby={id}>
      <dt>{stat.label}</dt>
      <dd className="numbers">{formatStat(stat.format, stat.value)}</dd>
      <dd className="stats-about" role="tooltip" id={id}>
        {stat.about}
      </dd>
    </div>
  );
}
