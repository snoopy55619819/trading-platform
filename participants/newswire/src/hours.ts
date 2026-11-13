// When news happens during the day. Companies announce mostly around the market: before the
// open and just after the close (earnings especially), less while it trades, and little
// overnight. Without this, as much news landed at 3am as at 9am, when nothing else was
// moving (ADR 0008, stage 4).
//
// A multiplier on every company's rate, in New York time. It averages 1 over the day, so
// the number of stories a day is unchanged; only when they land moves.

const NEW_YORK = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "numeric", hourCycle: "h23" });

function newYorkMinutes(date: Date): number {
  let hour = 0;
  let minute = 0;
  for (const part of NEW_YORK.formatToParts(date)) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/** The shape before scaling: relative busyness at each New York minute of the day. */
function shape(minutes: number): number {
  if (minutes < 6 * 60) return 0.2; // overnight
  if (minutes < 9 * 60 + 30) return 2; // before the open: most announcements
  if (minutes < 16 * 60) return 1; // while the market trades
  if (minutes < 18 * 60) return 2; // just after the close: earnings
  return 0.4; // evening
}

/** The shape's average over a day, so the multiplier averages exactly 1. */
const DAY_AVERAGE = Array.from({ length: 1440 }, (_, m) => shape(m)).reduce((a, b) => a + b, 0) / 1440;

/** How much busier than average news is at `date`: 0.23 overnight to 2.3 before the open. */
export function newsHours(date: Date): number {
  return shape(newYorkMinutes(date)) / DAY_AVERAGE;
}
