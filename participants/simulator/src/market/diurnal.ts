// The market trades 24/7, but not evenly. Volume and volatility follow the New York day:
// busiest at the open and close, steady through the session, thin overnight. Without this
// every hour of the chart looks the same.

const NEW_YORK = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  hour: "numeric",
  minute: "numeric",
  hourCycle: "h23",
});

/** Minutes since midnight in New York. */
function newYorkMinutes(date: Date): number {
  let hour = 0;
  let minute = 0;
  for (const part of NEW_YORK.formatToParts(date)) {
    if (part.type === "hour") hour = Number(part.value);
    if (part.type === "minute") minute = Number(part.value);
  }
  return hour * 60 + minute;
}

/**
 * Activity multiplier for this moment, about 0.2 overnight to 1.6 at the open. Applied to
 * order arrival rates and to fair value volatility alike.
 */
export function diurnal(date: Date): number {
  const minutes = newYorkMinutes(date);
  const open = 9 * 60 + 30;
  const close = 16 * 60;
  if (minutes >= open && minutes < open + 30) return 1.6; // the opening rush
  if (minutes >= close - 30 && minutes < close) return 1.4; // into the close
  if (minutes >= open && minutes < close) return 1.0;
  if (minutes >= 4 * 60 && minutes < open) return 0.5; // pre-market
  if (minutes >= close && minutes < 20 * 60) return 0.4; // after hours
  return 0.2; // overnight
}

/**
 * The average of the squared multiplier over a day, so the walk can be scaled to deliver a
 * symbol's whole daily volatility however the day is shaped (ADR 0008, stage 4). About 0.42:
 * without it, a symbol configured to move 3% a day moved about 2%, and news made up the rest.
 */
export const DAY_MEAN_SQUARE = (() => {
  let sum = 0;
  const start = Date.parse("2026-11-12T00:00:00Z"); // any ordinary weekday
  for (let m = 0; m < 1440; m++) sum += diurnal(new Date(start + m * 60_000)) ** 2;
  return sum / 1440;
})();

/**
 * The walk's variance per second at activity 1 is a day's variance divided by this: a day
 * of seconds scaled by the day's average squared activity, so a whole day of the time-of-day
 * curve adds up to the profile's daily volatility.
 */
export const WALK_DAY_SECONDS = 86_400 * DAY_MEAN_SQUARE;
