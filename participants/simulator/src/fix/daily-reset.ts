// When the simulator starts its FIX session over: once a day, at the venue's business-date
// roll (the published `business_date_roll_utc`, 21:00 UTC).
//
// A real trading firm resets its exchange session each trading day. For the exchange it
// also matters: it keeps a copy of every message it sends a session, in case one has to be
// resent, and only drops them when that session logs on again with fresh sequence numbers.
// The simulator never logs off on its own, so without this the copies would pile up forever.

const DAY_MS = 86_400_000;

/** `HH:MM:SS` as milliseconds after UTC midnight. */
export function timeOfDayMs(text: string): number {
  const match = /^(\d{2}):(\d{2}):(\d{2})$/.exec(text);
  if (!match) throw new Error(`not a time of day: ${text}`);
  const [hours, minutes, seconds] = match.slice(1).map(Number) as [number, number, number];
  if (hours >= 24 || minutes >= 60 || seconds >= 60) throw new Error(`not a time of day: ${text}`);
  return ((hours * 60 + minutes) * 60 + seconds) * 1000;
}

/**
 * The next reset strictly after `now`: the next `rollUtc`, or `everySecs` from now when
 * that is set (to watch a reset happen without waiting for the roll).
 */
export function nextSessionReset(now: number, rollUtc: string, everySecs = 0): number {
  if (everySecs > 0) return now + everySecs * 1000;
  const today = now - (now % DAY_MS) + timeOfDayMs(rollUtc);
  return today > now ? today : today + DAY_MS;
}
