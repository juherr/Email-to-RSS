import { FeedConfig, FeedMetadata, EmailMetadata } from "../types";
import { SenderPolicy, SenderDecision } from "./value-objects/sender-policy";

const HOUR_MS = 3_600_000;

export type { SenderDecision };

/**
 * The Feed aggregate's invariants, in one framework-agnostic place: expiry,
 * sender allow/block policy, and the email-size budget. No I/O and no ambient
 * time or environment — callers pass `now` (from a Clock) and a resolved
 * lifetime; persistence goes through the FeedRepository.
 */

/**
 * Resolve a feed's `expires_at` from an already-resolved lifetime (hours) and a
 * current instant. Returns undefined when no positive lifetime applies (i.e. the
 * feed never expires). The policy decision of *which* lifetime applies (a client
 * request vs. a server-side `FEED_TTL_HOURS` override, and parsing the env
 * string) belongs to the application layer, not here.
 */
export function resolveExpiresAt(
  ttlHours: number | undefined,
  now: number,
): number | undefined {
  return ttlHours !== undefined && Number.isFinite(ttlHours) && ttlHours > 0
    ? now + ttlHours * HOUR_MS
    : undefined;
}

/**
 * Whether a feed has reached its expiry instant. `now` defaults to the wall
 * clock for convenience at the HTTP edge (routes); the aggregate always passes
 * its injected clock so its own behaviour stays deterministic.
 */
export function isExpired(
  config: Pick<FeedConfig, "expires_at">,
  now: number = Date.now(),
): boolean {
  return config.expires_at !== undefined && config.expires_at <= now;
}

/**
 * Decide whether an inbound email is accepted, given the feed's sender lists and
 * the message's candidate sender addresses. Thin wrapper over the `SenderPolicy`
 * value object (which holds the matching semantics).
 */
export function applySenderPolicy(
  config: Pick<FeedConfig, "allowed_senders" | "blocked_senders">,
  senders: string[],
): SenderDecision {
  return SenderPolicy.fromLists(
    config.allowed_senders,
    config.blocked_senders,
  ).decide(senders);
}

/**
 * Enforce the per-feed byte budget by dropping the oldest emails (mutating
 * `metadata.emails`) until the total fits, always keeping at least one entry.
 * Returns the dropped entries so the caller can purge their KV/R2 storage.
 */
export function trimToByteBudget(
  metadata: FeedMetadata,
  maxBytes: number,
): { dropped: EmailMetadata[] } {
  let totalSize = metadata.emails.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const dropped: EmailMetadata[] = [];
  while (totalSize > maxBytes && metadata.emails.length > 1) {
    const entry = metadata.emails.pop()!;
    totalSize -= entry.size ?? 0;
    dropped.push(entry);
  }
  return { dropped };
}
