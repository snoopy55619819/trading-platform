// One flow of the guide, drawn as inline SVG (ADR 0007). Colours come from the theme's CSS
// variables (guide.css), so every style and mode works with nothing set here. The current
// step's arrow is lit, with a dot travelling along it; boxes the story has not reached yet
// are faded.

import { useId } from "react";

import { BOX, type Flow, VIEW, arrowLine, arrowsOf, nodeStates } from "./flows.ts";

export function FlowDiagram({ flow, step }: { flow: Flow; step: number }) {
  // useId's characters are not all valid in url(#...), so keep letters and digits only.
  const uid = `flow${useId().replace(/[^a-z0-9]/gi, "")}`;
  const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
  const states = nodeStates(flow, step);
  const current = flow.steps[step]!;
  const arrows = arrowsOf(flow);
  const pairs = new Set(arrows.map((a) => `${a.from}>${a.to}`));
  const firstUse = (from: string, to: string) => flow.steps.findIndex((s) => s.from === from && s.to === to);

  return (
    <svg className="flow" viewBox={`0 0 ${VIEW.width} ${VIEW.height}`} role="img" aria-label={`${flow.name}: step ${step + 1}, ${current.title}`}>
      <defs>
        {(["", "-lit"] as const).map((kind) => (
          <marker key={kind} id={`${uid}${kind}`} viewBox="0 0 10 10" refX="1" refY="5" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M 0 0 L 10 5 L 0 10 z" className={`flow-head${kind}`} />
          </marker>
        ))}
      </defs>

      {arrows.map(({ from, to }) => {
        const line = arrowLine(nodes.get(from)!, nodes.get(to)!, pairs.has(`${to}>${from}`));
        const lit = current.from === from && current.to === to;
        const state = lit ? "lit" : firstUse(from, to) <= step ? "done" : "later";
        return (
          <g key={`${from}>${to}`} className={`flow-arrow ${state}`}>
            <line {...line} markerEnd={`url(#${uid}${lit ? "-lit" : ""})`} />
            {lit && (
              // Keyed by step, so the dot starts again from the beginning on each step.
              <circle key={step} r="5" className="flow-dot">
                <animateMotion dur="1.4s" repeatCount="indefinite" path={`M ${line.x1} ${line.y1} L ${line.x2} ${line.y2}`} />
              </circle>
            )}
          </g>
        );
      })}

      {flow.nodes.map((node) => (
        <g key={node.id} className={`flow-box ${states.get(node.id)}`}>
          <rect x={node.x - BOX.width / 2} y={node.y - BOX.height / 2} width={BOX.width} height={BOX.height} rx="8" />
          <text x={node.x} y={node.y - 4} className="flow-name">
            {node.name}
          </text>
          <text x={node.x} y={node.y + 14} className="flow-sub">
            {node.sub}
          </text>
        </g>
      ))}
    </svg>
  );
}
