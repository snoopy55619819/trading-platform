// View variants: the rare differences between styles that CSS cannot express, chosen per
// style here and read by a section's view. Containers never look at these: every variant
// of a section shows the same data and does the same things, only laid out differently.

import { type Style, useTheme } from "./theme.ts";

export interface Variants {
  /**
   * form    every field at once (Pro)
   * quick   a quantity stepper, then Buy-at-the-ask and Sell-at-the-bid buttons (Active)
   * simple  side, shares and the estimate; limit price and time in force under More (Calm)
   */
  ticket: "form" | "quick" | "simple";
  /** table: a row per holding with every column; list: one line each, value and P&L (Calm) */
  positions: "table" | "list";
}

export const VARIANTS: Record<Style, Variants> = {
  pro: { ticket: "form", positions: "table" },
  active: { ticket: "quick", positions: "table" },
  calm: { ticket: "simple", positions: "list" },
};

export function useVariants(): Variants {
  return VARIANTS[useTheme().style];
}
