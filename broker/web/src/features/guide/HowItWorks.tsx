// "How it works?": a dialog with one tab per flow (ADR 0007). Each tab steps through a
// diagram, by Back and Next or by Play, with a line of live data under it that ties the
// diagram to what is on the screen.

import { useEffect, useState } from "react";

import { formatDollars } from "../../money.ts";
import { useLastPrices, useNews } from "../../market/hooks.ts";
import { usePositions } from "../../query/hooks.ts";
import { Dialog } from "../../ui/Dialog.tsx";
import { FLOWS, type FlowId, flowById } from "./flows.ts";
import { FlowDiagram } from "./FlowDiagram.tsx";
import "./guide.css";

/** How long Play stays on each step. */
const PLAY_MS = 4000;

export function HowItWorks({ open, onClose, symbol }: { open: boolean; onClose: () => void; symbol: string | undefined }) {
  return (
    <Dialog
      open={open}
      title="How it works"
      wide
      onClose={onClose}
      actions={
        <button type="button" className="button primary" onClick={onClose}>
          Close
        </button>
      }
    >
      <Guide symbol={symbol} />
    </Dialog>
  );
}

function Guide({ symbol }: { symbol: string | undefined }) {
  const [flowId, setFlowId] = useState<FlowId>("market");
  const [step, setStep] = useState(0);
  const [playing, setPlaying] = useState(false);
  const flow = flowById(flowId);
  const last = flow.steps.length - 1;
  const current = flow.steps[step]!;

  useEffect(() => {
    if (!playing) return;
    if (step >= last) {
      setPlaying(false);
      return;
    }
    const timer = setTimeout(() => setStep(step + 1), PLAY_MS);
    return () => clearTimeout(timer);
  }, [playing, step, last]);

  const choose = (id: FlowId) => {
    setFlowId(id);
    setStep(0);
    setPlaying(false);
  };

  return (
    <div className="guide">
      <div className="segmented guide-tabs" role="tablist" aria-label="Flows">
        {FLOWS.map((f) => (
          <button
            key={f.id}
            type="button"
            role="tab"
            aria-selected={f.id === flowId}
            className={f.id === flowId ? "segment selected" : "segment"}
            onClick={() => choose(f.id)}
          >
            {f.name}
          </button>
        ))}
      </div>
      <p className="guide-summary">{flow.summary}</p>

      <FlowDiagram flow={flow} step={step} />

      <div className="guide-step" aria-live="polite">
        <div className="guide-count">
          Step {step + 1} of {flow.steps.length}
        </div>
        <h3 className="guide-title">{current.title}</h3>
        <p className="guide-text">{current.text}</p>
      </div>

      <div className="guide-controls">
        <button type="button" className="button" onClick={() => {
            setPlaying(false);
            setStep(step - 1);
          }} disabled={step === 0}>
          Back
        </button>
        <button
          type="button"
          className="button"
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            if (step >= last) setStep(0);
            setPlaying(true);
          }}
        >
          {playing ? "Pause" : step >= last ? "Play again" : "Play"}
        </button>
        <button type="button" className="button primary" onClick={() => {
            setPlaying(false);
            setStep(step + 1);
          }} disabled={step >= last}>
          Next
        </button>
      </div>

      <LiveLine flowId={flowId} symbol={symbol} />
    </div>
  );
}

/** One fact from the running system, for the flows that have one. */
function LiveLine({ flowId, symbol }: { flowId: FlowId; symbol: string | undefined }) {
  if (flowId === "market") return <MarketLine symbol={symbol} />;
  if (flowId === "news") return <NewsLine />;
  if (flowId === "holdings") return <HoldingsLine />;
  return <p className="guide-live">Try it: place an order in the ticket, and follow it here step by step.</p>;
}

function MarketLine({ symbol }: { symbol: string | undefined }) {
  // The same price the watchlist and the quote show.
  const lastPriceCents = useLastPrices(symbol ? [symbol] : []).get(symbol ?? "");
  if (!symbol || lastPriceCents === undefined) return <p className="guide-live">Pick a symbol to see its latest price here.</p>;
  return (
    <p className="guide-live">
      Live: <strong>{symbol}</strong> last traded at <strong className="numbers">{formatDollars(lastPriceCents)}</strong>. That
      price took the path above.
    </p>
  );
}

function NewsLine() {
  const { news } = useNews(undefined, 1);
  const latest = news[0];
  if (!latest) return <p className="guide-live">No headlines yet.</p>;
  return (
    <p className="guide-live">
      Latest: <strong>{latest.symbol}</strong> {latest.headline}
    </p>
  );
}

function HoldingsLine() {
  const positions = usePositions();
  const cash = positions.data?.cashCents;
  if (cash === undefined) return null;
  return (
    <p className="guide-live">
      Live: your cash right now is <strong className="numbers">{formatDollars(cash)}</strong>.
    </p>
  );
}
