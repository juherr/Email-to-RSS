import { Env, FeedConfig, FeedMetadata, EmailMetadata } from "../types";
import { EmailAddress } from "./value-objects/email-address";
import { Domain } from "./value-objects/domain";

const HOUR_MS = 3_600_000;

/**
 * The Feed aggregate's invariants, in one framework-agnostic place: expiry,
 * sender allow/block policy, and the email-size budget. No I/O — callers load
 * and persist state through the FeedRepository.
 */

/**
 * Resolve a feed's `expires_at` from a requested lifetime (hours). A server-side
 * `FEED_TTL_HOURS` always overrides the client-supplied value. Returns undefined
 * when no positive lifetime applies (i.e. the feed never expires).
 */
export function resolveExpiresAt(
  env: Env,
  lifetimeHours?: number,
): number | undefined {
  const hours = env.FEED_TTL_HOURS
    ? parseInt(env.FEED_TTL_HOURS, 10)
    : (lifetimeHours ?? NaN);
  return Number.isFinite(hours) && hours > 0
    ? Date.now() + hours * HOUR_MS
    : undefined;
}

/** Whether a feed has reached its expiry instant. */
export function isExpired(
  config: Pick<FeedConfig, "expires_at">,
  now: number = Date.now(),
): boolean {
  return config.expires_at !== undefined && config.expires_at <= now;
}

export type SenderDecision = "accepted" | "blocked";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

type SenderMatch = "blocked" | "allowed" | "neutral";

function toDomains(entries: string[]): Domain[] {
  return entries
    .map((e) => Domain.parse(e))
    .filter((d): d is Domain => d !== null);
}

function evaluateSender(
  sender: string,
  allowedSenders: string[],
  blockedSenders: string[],
): SenderMatch {
  const parsed = EmailAddress.parse(sender);
  const normalized = parsed ? parsed.normalized : normalizeEmail(sender);
  const senderDomain = parsed?.domain ?? null;

  const exactBlocked = blockedSenders.filter((e) => e.includes("@"));
  const exactAllowed = allowedSenders.filter((e) => e.includes("@"));
  const domainBlocked = toDomains(
    blockedSenders.filter((e) => !e.includes("@")),
  );
  const domainAllowed = toDomains(
    allowedSenders.filter((e) => !e.includes("@")),
  );

  if (exactBlocked.includes(normalized)) return "blocked";
  if (exactAllowed.includes(normalized)) return "allowed";
  if (senderDomain && domainBlocked.some((d) => d.matches(senderDomain)))
    return "blocked";
  if (senderDomain && domainAllowed.some((d) => d.matches(senderDomain)))
    return "allowed";
  return "neutral";
}

/**
 * Decide whether an inbound email is accepted, given the feed's sender lists and
 * the message's candidate sender addresses. With no lists configured everything
 * is accepted; a blocklist hit always rejects; an allowlist (when present) must
 * be matched by at least one sender.
 */
export function applySenderPolicy(
  config: Pick<FeedConfig, "allowed_senders" | "blocked_senders">,
  senders: string[],
): SenderDecision {
  const allowedSenders = (config.allowed_senders || [])
    .map(normalizeEmail)
    .filter(Boolean);
  const blockedSenders = (config.blocked_senders || [])
    .map(normalizeEmail)
    .filter(Boolean);

  if (allowedSenders.length === 0 && blockedSenders.length === 0) {
    return "accepted";
  }

  const hasAllowlist = allowedSenders.length > 0;
  const accepted = senders.some((sender) => {
    const decision = evaluateSender(sender, allowedSenders, blockedSenders);
    if (decision === "allowed") return true;
    if (decision === "blocked") return false;
    return !hasAllowlist;
  });

  return accepted ? "accepted" : "blocked";
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
