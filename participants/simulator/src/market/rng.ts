// A small seeded random number generator, so a run (and every test) can be repeated
// exactly. Math.random cannot be seeded.

export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0 || 1;
  }

  /** Uniform in [0, 1). mulberry32: tiny, fast, and plenty for a simulation. */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Standard normal, by Box-Muller. */
  normal(): number {
    const u = 1 - this.next(); // (0, 1], so the log is finite
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }

  /** Did an event with `ratePerSec` happen in the last `dtSec`? (Poisson arrivals.) */
  chance(ratePerSec: number, dtSec: number): boolean {
    return this.next() < 1 - Math.exp(-ratePerSec * dtSec);
  }

  /**
   * How many events with `ratePerSec` happened in the last `dtSec` (a Poisson count). The
   * same as `chance` while events are rare; unlike it, more than one when they are not, so
   * a fast rate is not capped at one event a step.
   */
  count(ratePerSec: number, dtSec: number): number {
    const mean = ratePerSec * dtSec;
    if (mean > 30) return Math.max(0, Math.round(mean + Math.sqrt(mean) * this.normal()));
    const limit = Math.exp(-mean);
    let k = 0;
    for (let p = this.next(); p > limit; p *= this.next()) k += 1;
    return k;
  }

  /** A whole number in [low, high]. */
  int(low: number, high: number): number {
    return low + Math.floor(this.next() * (high - low + 1));
  }

  pick<T>(items: readonly T[]): T {
    const item = items[Math.floor(this.next() * items.length)];
    if (item === undefined) throw new Error("pick from an empty list");
    return item;
  }
}
