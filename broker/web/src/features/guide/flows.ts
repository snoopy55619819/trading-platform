// The "How it works?" guide's four flows (ADR 0007), as data: the boxes, where they sit, and
// the steps a user clicks through. A step is an arrow from one box to another, with a short
// title and a plain sentence or two. The words must stay true to the system: change them in
// the same change as the flow they describe.

/** One part of the system, drawn as a box. x and y are its centre in the diagram's viewBox. */
export interface FlowNode {
  id: string;
  name: string;
  /** A short second line: what it is. */
  sub: string;
  x: number;
  y: number;
}

/** One step. `from` is missing on the first step, which only lights its box. */
export interface FlowStep {
  from?: string;
  to: string;
  title: string;
  text: string;
}

export interface Flow {
  id: FlowId;
  /** The tab's name. */
  name: string;
  /** One sentence under the tabs. */
  summary: string;
  nodes: FlowNode[];
  steps: FlowStep[];
}

export const FLOW_IDS = ["market", "news", "holdings", "trade"] as const;
export type FlowId = (typeof FLOW_IDS)[number];

/** The diagram's coordinate space, and the size of every box in it. */
export const VIEW = { width: 640, height: 250 } as const;
export const BOX = { width: 156, height: 54 } as const;

// Three columns and two rows are enough for every flow.
const LEFT = 98;
const MIDDLE = 320;
const RIGHT = 542;
const TOP = 60;
const BOTTOM = 190;

const you: FlowNode = { id: "you", name: "You", sub: "this web app", x: LEFT, y: TOP };

export const FLOWS: readonly Flow[] = [
  {
    id: "market",
    name: "Market data",
    summary: "Where the prices, the chart and the order book on your screen come from.",
    nodes: [
      { id: "firms", name: "Trading firms", sub: "simulated traders", x: LEFT, y: BOTTOM },
      { id: "exchange", name: "Exchange", sub: "Rust matching engine", x: MIDDLE, y: BOTTOM },
      { id: "md", name: "Market data", sub: "the broker's service", x: RIGHT, y: BOTTOM },
      { id: "mddb", name: "Price history", sub: "its own database", x: MIDDLE, y: TOP },
      { ...you, x: RIGHT },
    ],
    steps: [
      {
        to: "firms",
        title: "Firms send orders",
        text: "Simulated trading firms buy and sell all day. They connect to the exchange the same way any broker does, with no shortcut.",
      },
      {
        from: "firms",
        to: "exchange",
        title: "The exchange matches them",
        text: "The exchange keeps the order book in memory and matches buyers with sellers. It is the source of truth: a trade happened only if the exchange says so.",
      },
      {
        from: "exchange",
        to: "md",
        title: "Every change is published",
        text: "Each trade and order book change goes out on a public feed to everyone, with no names on it. Every message is numbered, so a missed one is noticed and recovered.",
      },
      {
        from: "md",
        to: "mddb",
        title: "The broker saves it",
        text: "The broker's market-data service listens to the feed, stores every trade, and builds the candles the chart draws (1 minute, 5 minutes and up).",
      },
      {
        from: "md",
        to: "you",
        title: "Your screen updates",
        text: "It pushes each change to your browser over a WebSocket as it happens. The chart's history comes from the saved candles.",
      },
    ],
  },
  {
    id: "news",
    name: "News",
    summary: "Where headlines come from, and why a price jumps after one.",
    nodes: [
      { id: "wire", name: "Newswire", sub: "a news company", x: LEFT, y: TOP },
      { id: "firms", name: "Trading firms", sub: "simulated traders", x: LEFT, y: BOTTOM },
      { id: "exchange", name: "Exchange", sub: "Rust matching engine", x: MIDDLE, y: BOTTOM },
      { id: "md", name: "Market data", sub: "the broker's service", x: MIDDLE, y: TOP },
      { ...you, x: RIGHT },
    ],
    steps: [
      {
        to: "wire",
        title: "A headline is published",
        text: "A newswire publishes stories about the listed companies: an earnings beat, a product recall. The companies are made up, so the newswire invents its stories too.",
      },
      {
        from: "wire",
        to: "firms",
        title: "Traders read it",
        text: "The simulated firms subscribe to the wire and decide what each story is worth. Good news raises what they will pay, bad news lowers it.",
      },
      {
        from: "firms",
        to: "exchange",
        title: "The price moves",
        text: "Their orders move the price on the exchange, and trading gets busier and choppier for a few minutes before it calms down at the new level.",
      },
      {
        from: "wire",
        to: "md",
        title: "The broker saves it",
        text: "The broker's market-data service subscribes to the same wire and stores each headline and its story.",
      },
      {
        from: "md",
        to: "you",
        title: "You see it",
        text: "It pushes the headline to your browser. It shows in the News panel, and as a dot on the chart at the candle where it landed.",
      },
    ],
  },
  {
    id: "holdings",
    name: "Your holdings",
    summary: "Who keeps track of your cash and shares.",
    nodes: [
      you,
      { id: "broker", name: "Broker", sub: "your account", x: MIDDLE, y: TOP },
      { id: "ledger", name: "Ledger", sub: "the broker's database", x: RIGHT, y: TOP },
      { id: "md", name: "Market data", sub: "live prices", x: LEFT, y: BOTTOM },
    ],
    steps: [
      {
        to: "you",
        title: "Your account lives at the broker",
        text: "The exchange only knows that the broker traded. Which customer owns what is the broker's record, as with a real brokerage.",
      },
      {
        from: "you",
        to: "broker",
        title: "The app asks the broker",
        text: "The app asks the broker for your cash, positions and orders, and asks again every few seconds while an order is open.",
      },
      {
        from: "broker",
        to: "ledger",
        title: "Everything is a ledger entry",
        text: "Every change, a deposit or a fill, is a double-entry ledger entry: money moves from one account to another and is never created. The database refuses an entry that does not balance.",
      },
      {
        from: "ledger",
        to: "broker",
        title: "Holdings are added up",
        text: "Your cash and shares are not stored as a number that goes up and down. They are the sum of your ledger entries, so they can always be checked.",
      },
      {
        from: "broker",
        to: "you",
        title: "The app shows them",
        text: "The broker sends back your cash, shares and what they cost you.",
      },
      {
        from: "md",
        to: "you",
        title: "Prices come from market data",
        text: "What your shares are worth now, and your profit or loss, uses live prices from market data. The app joins the two itself, so the broker never depends on market data.",
      },
    ],
  },
  {
    id: "trade",
    name: "Placing a trade",
    summary: "What happens between pressing Buy and seeing your shares.",
    nodes: [
      you,
      { id: "broker", name: "Broker", sub: "orders and ledger", x: MIDDLE, y: TOP },
      { id: "exchange", name: "Exchange", sub: "Rust matching engine", x: RIGHT, y: TOP },
      { id: "md", name: "Market data", sub: "the public feed", x: MIDDLE, y: BOTTOM },
    ],
    steps: [
      {
        to: "you",
        title: "You press Buy",
        text: "The app sends your order to the broker: the symbol, how many shares, and the price for a limit order.",
      },
      {
        from: "you",
        to: "broker",
        title: "The broker checks it",
        text: "The broker checks you have the buying power, sets that cash aside, and records the order, all in one database transaction.",
      },
      {
        from: "broker",
        to: "exchange",
        title: "It goes to the exchange",
        text: "The broker sends the order over FIX 4.4, the standard protocol brokers and exchanges use. The matching engine looks for sellers at your price or better, best price first, then whoever was there first.",
      },
      {
        from: "exchange",
        to: "broker",
        title: "Your order fills",
        text: "The exchange reports the fill back over FIX. The broker books it in the ledger: cash out of your account, shares in.",
      },
      {
        from: "broker",
        to: "you",
        title: "Your holdings update",
        text: "The app sees the fill, shows a confirmation, and updates your positions and cash.",
      },
      {
        from: "exchange",
        to: "md",
        title: "The trade is published",
        text: "The exchange also publishes the trade on the public feed, with no names. Everyone watching sees it, so your trade reaches you twice: privately as your fill, publicly as a print.",
      },
      {
        from: "md",
        to: "you",
        title: "The market moves",
        text: "Your trade appears in time and sales and on the chart, and the order book shows the shares you took are gone.",
      },
    ],
  },
];

export const flowById = (id: FlowId): Flow => FLOWS.find((f) => f.id === id)!;

/** Problems with a flow's data, if any: steps naming missing boxes, unused boxes, boxes off the edge. */
export function flowProblems(flow: Flow): string[] {
  const problems: string[] = [];
  const ids = new Set(flow.nodes.map((n) => n.id));
  if (ids.size !== flow.nodes.length) problems.push("two boxes share an id");
  const reached = new Set<string>();
  flow.steps.forEach((step, i) => {
    if (!ids.has(step.to)) problems.push(`step ${i + 1} goes to a missing box, ${step.to}`);
    if (i === 0 && step.from !== undefined) problems.push("the first step has an arrow");
    if (i > 0 && step.from === undefined) problems.push(`step ${i + 1} has no arrow`);
    if (step.from !== undefined && !ids.has(step.from)) problems.push(`step ${i + 1} comes from a missing box, ${step.from}`);
    reached.add(step.to);
    if (step.from !== undefined) reached.add(step.from);
  });
  const unused = flow.nodes.filter((n) => !reached.has(n.id)).map((n) => n.id);
  if (unused.length > 0) problems.push(`boxes never used: ${unused.join(", ")}`);
  for (const node of flow.nodes) {
    const inside =
      node.x - BOX.width / 2 >= 0 && node.x + BOX.width / 2 <= VIEW.width && node.y - BOX.height / 2 >= 0 && node.y + BOX.height / 2 <= VIEW.height;
    if (!inside) problems.push(`box ${node.id} is outside the diagram`);
  }
  return problems;
}

/** Every distinct arrow in a flow, in the order its steps first use them. */
export function arrowsOf(flow: Flow): { from: string; to: string }[] {
  const seen = new Set<string>();
  const arrows: { from: string; to: string }[] = [];
  for (const { from, to } of flow.steps) {
    if (from === undefined || seen.has(`${from}>${to}`)) continue;
    seen.add(`${from}>${to}`);
    arrows.push({ from, to });
  }
  return arrows;
}

/** How far apart the two arrows of a back-and-forth pair are drawn. */
const PAIR_GAP = 14;
/** Space left between an arrow's tip and the box, for the arrowhead. */
const TIP_GAP = 6;

/**
 * Where an arrow from box `a` to box `b` starts and ends: on the edges of the two boxes, not
 * their centres. When the flow also has an arrow back from `b` to `a`, each is moved to its
 * own side so the two do not overlap.
 */
export function arrowLine(a: FlowNode, b: FlowNode, paired: boolean): { x1: number; y1: number; x2: number; y2: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  // To the right of the direction of travel, so a pair sits on opposite sides.
  const shift = paired ? PAIR_GAP / 2 : 0;
  const ox = -uy * shift;
  const oy = ux * shift;
  // How far along the line the box's edge is, from its centre.
  const toEdge = Math.min(
    ux === 0 ? Infinity : BOX.width / 2 / Math.abs(ux),
    uy === 0 ? Infinity : BOX.height / 2 / Math.abs(uy),
  );
  const round = (n: number) => Math.round(n * 10) / 10;
  return {
    x1: round(a.x + ox + ux * toEdge),
    y1: round(a.y + oy + uy * toEdge),
    x2: round(b.x + ox - ux * (toEdge + TIP_GAP)),
    y2: round(b.y + oy - uy * (toEdge + TIP_GAP)),
  };
}

/** Each box's state at a step: the one just reached, ones already part of the story, or not yet. */
export function nodeStates(flow: Flow, step: number): Map<string, "current" | "done" | "later"> {
  const states = new Map<string, "current" | "done" | "later">(flow.nodes.map((n) => [n.id, "later"]));
  flow.steps.slice(0, step + 1).forEach((s) => {
    if (s.from !== undefined) states.set(s.from, "done");
    states.set(s.to, "done");
  });
  states.set(flow.steps[step]!.to, "current");
  return states;
}
