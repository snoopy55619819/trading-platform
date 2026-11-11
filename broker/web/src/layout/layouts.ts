// Layouts as data. Each style has a default layout: which panels it shows and where each
// sits. Shell draws whatever layout it is given, so a layout the user arranged (dragged,
// resized, added to) is drawn exactly the same way as a default.
//
// The shape follows what grid-based drag-and-drop editors use (react-grid-layout and
// similar): a panel is an instance with an id, and its placement is x, y, w, h on a
// 12-column grid. Dragging changes x and y, resizing changes w and h, adding appends a
// panel and a placement. Nothing here knows about dragging yet; it only has to be the
// right shape for it.

export const SECTION_TYPES = ["watchlist", "chart", "book", "tape", "ticket", "activity"] as const;
export type SectionType = (typeof SECTION_TYPES)[number];

/** One panel on screen. Its id is unique within a layout; its type says what it shows. */
export interface PanelInstance {
  id: string;
  type: SectionType;
  /** Per-instance settings (a second chart's symbol, say). None yet. */
  props?: Record<string, unknown>;
}

/** Where a panel sits on the desktop grid, in grid cells. */
export interface Placement {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Layout {
  /**
   * screen: the grid fills the window exactly; a panel taller than its cells scrolls
   *         inside itself. Rows are `rows` equal shares of the height.
   * flow:   rows size to their content and the page scrolls; `h` is a minimum height,
   *         in units of FLOW_ROW_PX, and 0 means "as tall as its content".
   */
  fit: "screen" | "flow";
  columns: number;
  /** For `screen`: how many rows the height is divided into. */
  rows: number;
  /** For `flow`: the widest the layout gets, centred. */
  maxWidthPx?: number;
  panels: PanelInstance[];
  desktop: Placement[];
  /** Panel ids, top to bottom, at phone width. A panel not listed is not shown there. */
  phone: string[];
}

export const COLUMNS = 12;
export const FLOW_ROW_PX = 40;

const panel = (type: SectionType): PanelInstance => ({ id: type, type });
const at = (id: string, x: number, y: number, w: number, h: number): Placement => ({ id, x, y, w, h });

/** The defaults for each style. A user's own layout, when saved, replaces one of these. */
export const DEFAULT_LAYOUTS = {
  // Chart in the middle, everything else around it at once.
  pro: {
    fit: "screen",
    columns: COLUMNS,
    rows: 12,
    panels: SECTION_TYPES.map(panel),
    desktop: [
      at("watchlist", 0, 0, 2, 12),
      at("chart", 2, 0, 7, 8),
      at("activity", 2, 8, 7, 4),
      at("book", 9, 0, 3, 4),
      at("ticket", 9, 4, 3, 5),
      at("tape", 9, 9, 3, 3),
    ],
    phone: ["chart", "ticket", "book", "activity", "watchlist", "tape"],
  },
  // Trading first: the ticket and book beside the chart.
  active: {
    fit: "screen",
    columns: COLUMNS,
    rows: 12,
    panels: SECTION_TYPES.map(panel),
    desktop: [
      at("watchlist", 0, 0, 2, 8),
      at("chart", 2, 0, 7, 8),
      at("activity", 0, 8, 9, 4),
      at("ticket", 9, 0, 3, 5),
      at("book", 9, 5, 3, 4),
      at("tape", 9, 9, 3, 3),
    ],
    phone: ["chart", "ticket", "book", "tape", "activity", "watchlist"],
  },
  // One thing at a time: a single centred column, no depth or tape.
  calm: {
    fit: "flow",
    columns: COLUMNS,
    rows: 0,
    maxWidthPx: 880,
    panels: (["chart", "ticket", "activity", "watchlist"] as const).map(panel),
    desktop: [
      at("chart", 0, 0, 12, 10),
      at("ticket", 0, 1, 12, 0),
      at("activity", 0, 2, 12, 0),
      at("watchlist", 0, 3, 12, 0),
    ],
    phone: ["chart", "ticket", "activity", "watchlist"],
  },
} as const satisfies Record<string, Layout>;

/**
 * Everything wrong with a layout, empty when it is sound. A layout the user saved is
 * checked before it is used; a bad one is replaced by the style's default.
 */
export function validateLayout(layout: Layout): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const p of layout.panels) {
    if (ids.has(p.id)) problems.push(`two panels are called ${p.id}`);
    ids.add(p.id);
    if (!SECTION_TYPES.includes(p.type)) problems.push(`${p.id} has an unknown type ${String(p.type)}`);
  }

  const placed = new Set<string>();
  for (const p of layout.desktop) {
    if (!ids.has(p.id)) problems.push(`a placement refers to ${p.id}, which is not a panel`);
    if (placed.has(p.id)) problems.push(`${p.id} is placed twice`);
    placed.add(p.id);
    const whole = [p.x, p.y, p.w, p.h].every(Number.isInteger);
    if (!whole || p.x < 0 || p.y < 0 || p.w < 1 || p.h < 0 || p.x + p.w > layout.columns) {
      problems.push(`${p.id} does not fit the ${layout.columns}-column grid`);
    }
    if (layout.fit === "screen" && (p.h < 1 || p.y + p.h > layout.rows)) {
      problems.push(`${p.id} does not fit the ${layout.rows} rows`);
    }
  }
  for (const id of ids) if (!placed.has(id)) problems.push(`${id} has no place on the desktop`);

  // On a screen layout two panels may not share a cell. (A flow layout's rows have no
  // fixed size, so it only needs distinct rows per column, checked the same way with h=1.)
  const cells = new Map<string, string>();
  for (const p of layout.desktop) {
    const height = layout.fit === "screen" ? p.h : 1;
    for (let y = p.y; y < p.y + height; y++) {
      for (let x = p.x; x < p.x + p.w; x++) {
        const other = cells.get(`${x},${y}`);
        if (other && other !== p.id) problems.push(`${p.id} overlaps ${other}`);
        cells.set(`${x},${y}`, p.id);
      }
    }
  }

  for (const id of layout.phone) if (!ids.has(id)) problems.push(`the phone order lists ${id}, which is not a panel`);
  return [...new Set(problems)];
}
