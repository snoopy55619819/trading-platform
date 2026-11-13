# ADR 0007: A "How it works?" guide in the web app, drawn with hand-written SVG

**Status:** accepted, 2026-11-12. Built in `broker/web/src/features/guide/`.

## Context

A visitor to the live app sees a normal trading screen. Nothing on it says that behind the
screen there is a Rust exchange with its own matching engine, FIX messages between two
companies, a public market data feed, a double-entry ledger and a newswire. That work is the
point of the project, and the README is the only place that explains it.

The app should explain itself, inside the app, in the four flows a user meets:

1. **Market data:** where a price on the screen comes from.
2. **News:** where a headline comes from, and why the price jumps after it.
3. **Your holdings:** who keeps your cash and shares.
4. **Placing a trade:** what happens between pressing Buy and seeing the shares.

Each flow is a handful of boxes and arrows, best followed one step at a time: a whole
diagram shown at once is hard to read for someone new to it.

The diagrams must work in the four styles (Pro, Active, Calm, Terminal) and both modes, which
are all CSS variables (`theme/tokens.css`). The web app has three runtime libraries (React,
TanStack Query, lightweight-charts) and keeps it that way unless a library clearly pays.

## Options

**Where the guide lives:**

1. **A page in the docs** (the architecture diagrams on GitHub Pages). Already exists, but
   it is written for engineers, and a visitor to the app never finds it.
2. **A dialog opened from a "How it works?" button in the top bar,** one tab per flow.
   Always one click away, and closes back to the screen the user was on.
3. **A guided tour that points at the real panels.** Engaging, but it breaks whenever a
   layout changes, and there are four layouts plus phone width.

**How the diagrams are drawn** (compared on 2026-11-12, sizes minified and gzipped):

4. **React Flow** (`@xyflow/react`, about 60 KB, MIT). Built for diagrams users drag, pan and
   zoom. Its nodes are React components, so the CSS variables work. About the size of the
   chart library, for a few fixed boxes.
5. **Mermaid** (about 159 KB, MIT). Draws a diagram from text at runtime and injects the SVG
   it makes. It has a long run of security advisories (XSS in 2025, HTML injection and denial
   of service in 2026), all fixed in current versions, but parsing text into markup is the
   kind of code those keep coming from. It themes through JavaScript settings, not CSS
   variables, and has no step-by-step highlighting.
6. **Excalidraw, tldraw, D2.** Whiteboards and diagram compilers: 350 KB to several MB,
   tldraw needs a licence key in production, and none is meant to be embedded as a small
   read-only diagram.
7. **Hand-written SVG in a React component.** Nothing added to the bundle, nothing parsed at
   runtime, and `stroke: var(--accent)` picks up every style and mode. The cost is placing the
   boxes by hand, which for four to six boxes is a few coordinates.

**Claude Code diagramming skills** were also checked, as a way to draw the diagrams. None is
published in Anthropic's own skills or plugins repositories. Several third-party ones are
flagged by automated scanners, for example for downloading their code from an unpinned
personal repository at install time. A skill runs with the developer's permissions, so none
was used.

## Decision

Options 2 and 7.

- **A "How it works?" button** in the top bar, beside Settings, opens a dialog on the
  existing `Dialog` component, with four tabs: Market data, News, Your holdings, Placing a
  trade.
- **Each flow is data** in `features/guide/flows.ts`: the boxes (a name, a short line under
  it, a position) and the steps. A step is an arrow from one box to another, with a title
  and one or two plain sentences. A box can appear in more than one step, so an order can
  go to the exchange and its fill come back.
- **One `FlowDiagram` component** draws any flow as inline SVG. The current step's arrow is
  in the accent colour with a dot travelling along it, and its box is outlined; boxes not
  reached yet are faded. Back, Next and Play move through the steps. The dot is hidden for
  users who ask their system for reduced motion.
- **A live line under each diagram** ties it to the screen: the selected symbol's last
  trade price, the latest headline, or the user's cash right now.
- **Three ways in,** so people know it exists without being made to sit through it:
  - the top bar button is in the accent colour, with a dot until this browser has opened
    the guide once (`guideSeen` in the saved settings);
  - the sign-in page has a link to it, for a visitor deciding whether to sign up (the guide
    works without an account, minus the live lines);
  - a new account gets a welcome toast with a button that opens it.

  Opening it on its own at the first visit, and a banner, were rejected: both cost every
  user attention to reach the ones who want it.
- **Animation is SVG and CSS only** (`<animateMotion>`). A motion library can be added later
  if the animations outgrow that.

Option 1 is kept for engineers; option 3 was rejected because four layouts would break it.
Options 4 to 6 add size, and for Mermaid a parser of untrusted-looking text, for something
four fixed diagrams do not need.

## Consequences

- **No new dependency,** and no change to any service: the guide is web-only and reads data
  the app already has.
- **The diagrams are code,** reviewed and tested like the rest. A unit test checks that every
  flow's steps name real boxes, that every box is used, and that every box fits inside the
  diagram.
- **The words must stay true** when the system changes. The guide sits next to the code it
  describes in this repo, and the ADR that changes a flow should change its steps too.
- **Boxes are placed by hand.** Adding a fifth box to a flow means choosing its position.
  That is fine at this size; a flow that needed automatic layout would be a sign the guide
  is saying too much.
- **Later, if wanted** (in `docs/BACKLOG.md`): a "See what just happened" link after an
  order fills that opens the trade tab.
