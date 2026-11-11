// The trading screen's frame: puts each section in its named area. Where each area sits is
// decided by the style, in layout.css; the sections themselves never know.

import type { ReactNode } from "react";

export const AREAS = ["header", "watch", "chart", "book", "tape", "ticket", "bottom"] as const;
export type Area = (typeof AREAS)[number];

export function Shell({ areas }: { areas: Partial<Record<Area, ReactNode>> }) {
  return (
    <div className="shell">
      {AREAS.map((area) =>
        areas[area] === undefined ? null : (
          <section key={area} className={`area area-${area}`} aria-label={area}>
            {areas[area]}
          </section>
        ),
      )}
    </div>
  );
}

/** The card every section sits in. */
export function Panel({ title, actions, children }: { title?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="panel">
      {title !== undefined && (
        <header className="panel-head">
          <span>{title}</span>
          {actions}
        </header>
      )}
      <div className="panel-body">{children}</div>
    </div>
  );
}
