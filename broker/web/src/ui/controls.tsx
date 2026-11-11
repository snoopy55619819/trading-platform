// Small shared controls. Each takes its look from the tokens only.

import type { ReactNode } from "react";

/** A row of mutually exclusive choices: the mode, the style, buy or sell, an interval. */
export function Segmented<T extends string>({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: readonly { value: T; label: ReactNode }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          className={option.value === value ? "segment selected" : "segment"}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * The quantity after pressing - or +: moves by `step` and lands on a multiple of it, never
 * below one step. Text that is not a number starts again from one step.
 */
export function stepQty(text: string, direction: 1 | -1, step = 1): number {
  const current = Number(text.trim().replaceAll(",", ""));
  if (!Number.isSafeInteger(current) || current < step) return step;
  const onStep = direction > 0 ? Math.floor(current / step) * step + step : Math.ceil(current / step) * step - step;
  return Math.max(step, onStep);
}

/** A whole-number field with - and + beside it. */
export function Stepper({
  label,
  value,
  step = 1,
  onChange,
}: {
  label: string;
  value: string;
  step?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div className="stepper">
      <button type="button" className="stepper-button" aria-label={`Fewer ${label.toLowerCase()}`} onClick={() => onChange(String(stepQty(value, -1, step)))}>
        −
      </button>
      <input
        className="input numbers stepper-input"
        inputMode="numeric"
        autoComplete="off"
        aria-label={label}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      />
      <button type="button" className="stepper-button" aria-label={`More ${label.toLowerCase()}`} onClick={() => onChange(String(stepQty(value, 1, step)))}>
        +
      </button>
    </div>
  );
}
