// Money in the browser. Every amount is integer cents, exactly as the services send it;
// this file is the only place cents become text or text becomes cents, and neither
// direction goes through a floating-point number.

/** 421500 -> "4,215.00"; -51 -> "-0.51". */
export function formatCents(cents: number, options: { grouping?: boolean } = {}): string {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const whole = Math.trunc(abs / 100);
  const wholeText = options.grouping === false ? String(whole) : whole.toLocaleString("en-US");
  return `${sign}${wholeText}.${String(abs % 100).padStart(2, "0")}`;
}

/** 421500 -> "$4,215.00"; -51 -> "-$0.51". */
export function formatDollars(cents: number): string {
  return cents < 0 ? `-$${formatCents(-cents)}` : `$${formatCents(cents)}`;
}

/** 126 -> "+$1.26", -84 -> "-$0.84", 0 -> "$0.00". For profit and change. */
export function formatSignedDollars(cents: number): string {
  return cents > 0 ? `+${formatDollars(cents)}` : formatDollars(cents);
}

/**
 * What someone typed, as cents: "42.1" -> 4210, "$1,000" -> 100000. Undefined for anything
 * that is not a plain non-negative amount with at most two decimals; "42.105" is refused
 * rather than rounded, so a price is never changed behind the user's back.
 */
export function parseDollars(text: string): number | undefined {
  const cleaned = text.trim().replace(/^\$/, "").replaceAll(",", "");
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(cleaned);
  if (!match) return undefined;
  const [, whole = "", fraction = ""] = match;
  const cents = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(cents) ? cents : undefined;
}

/** Change as basis points of a reference, for showing a percentage: (4250, 4200) -> 119. */
export function changeBps(cents: number, referenceCents: number): number | undefined {
  if (referenceCents <= 0) return undefined;
  return Math.round(((cents - referenceCents) * 10_000) / referenceCents);
}

/** 119 -> "+1.19%". */
export function formatBps(bps: number): string {
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  const abs = Math.abs(bps);
  return `${sign}${Math.trunc(abs / 100)}.${String(abs % 100).padStart(2, "0")}%`;
}
