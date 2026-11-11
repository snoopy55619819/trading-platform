// The trading screen's frame: a fixed top bar, then whatever layout it is given. Each
// panel's place comes from the layout's data (see layout/layouts.ts), set as CSS variables
// that layout.css turns into grid positions on a desktop and a single column on a phone.
// Sections never know where they are, and a layout the user arranges is drawn the same way
// as a default one.

import type { CSSProperties, ReactNode } from "react";

import { FLOW_ROW_PX, type Layout, type PanelInstance } from "../layout/layouts.ts";

export function Shell({
  layout,
  header,
  render,
}: {
  layout: Layout;
  header: ReactNode;
  /** What to show for a panel: the section for its type. */
  render: (panel: PanelInstance) => ReactNode;
}) {
  const placements = new Map(layout.desktop.map((p) => [p.id, p]));
  const phoneOrder = new Map(layout.phone.map((id, i) => [id, i]));
  const shellStyle = {
    "--columns": layout.columns,
    "--rows": layout.rows,
    ...(layout.maxWidthPx ? { "--max-width": `${layout.maxWidthPx}px` } : {}),
  } as CSSProperties;

  return (
    <div className={`shell fit-${layout.fit}`} style={shellStyle}>
      <header className="shell-header">{header}</header>
      <div className="grid">
        {layout.panels.map((panel) => {
          const place = placements.get(panel.id);
          if (!place) return null;
          const order = phoneOrder.get(panel.id);
          const style = {
            "--col": `${place.x + 1} / span ${place.w}`,
            "--row": `${place.y + 1} / span ${layout.fit === "screen" ? place.h : 1}`,
            "--min-h": layout.fit === "flow" && place.h > 0 ? `${place.h * FLOW_ROW_PX}px` : "auto",
            "--order": order ?? 0,
          } as CSSProperties;
          return (
            <section
              key={panel.id}
              className={order === undefined ? "area hide-on-phone" : "area"}
              data-type={panel.type}
              aria-label={panel.type}
              style={style}
            >
              {render(panel)}
            </section>
          );
        })}
      </div>
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
