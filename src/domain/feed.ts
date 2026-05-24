import { FeedConfig } from "../types";

/**
 * The expiry predicate, shared between the Feed aggregate and the read-model
 * routes (rss/atom/entries) that render from a config snapshot without loading
 * the aggregate. This is the *only* feed invariant that lives outside the
 * aggregate, precisely because the hot read path bypasses it.
 *
 * `now` defaults to the wall clock for convenience at the HTTP edge; the
 * aggregate always passes its injected clock so its own behaviour stays
 * deterministic.
 */
export function isExpired(
  config: Pick<FeedConfig, "expires_at">,
  now: number = Date.now(),
): boolean {
  return config.expires_at !== undefined && config.expires_at <= now;
}
