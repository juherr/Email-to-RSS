const HOUR_MS = 3_600_000;

/**
 * A feed's lifetime as a value object: either a positive number of hours or
 * "never". `resolveExpiry(now)` turns it into an absolute `expires_at` instant
 * (or undefined for a feed that never expires).
 *
 * Which lifetime applies — client request vs. server-side `FEED_TTL_HOURS`
 * override — is the application layer's policy; it builds the VO and hands it to
 * the aggregate. The aggregate never parses env config or reaches for a clock to
 * compute expiry itself.
 */
export class Lifetime {
  private constructor(private readonly hours: number | undefined) {}

  /** A finite, positive lifetime. Non-positive/non-finite inputs collapse to never. */
  static ofHours(hours: number): Lifetime {
    return new Lifetime(hours);
  }

  /** A feed that never expires. */
  static readonly never = new Lifetime(undefined);

  /** The absolute expiry instant for this lifetime, or undefined if it never expires. */
  resolveExpiry(now: number): number | undefined {
    return this.hours !== undefined &&
      Number.isFinite(this.hours) &&
      this.hours > 0
      ? now + this.hours * HOUR_MS
      : undefined;
  }
}
