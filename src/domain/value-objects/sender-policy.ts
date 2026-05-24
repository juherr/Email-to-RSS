import { EmailAddress } from "./email-address";
import { Domain } from "./domain";

export type SenderDecision = "accepted" | "blocked";

type SenderMatch = "blocked" | "allowed" | "neutral";

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function toDomains(entries: string[]): Domain[] {
  return entries
    .map((e) => Domain.parse(e))
    .filter((d): d is Domain => d !== null);
}

/**
 * The sender allow/block policy as a value object, built ONCE from a feed's
 * lists. The exact-vs-domain split is pre-computed here so `decide` is a cheap
 * lookup per candidate sender instead of re-parsing both lists for every one
 * (the previous `applySenderPolicy` was O(senders × lists)).
 *
 * Semantics (unchanged): no lists ⇒ everything accepted; a blocklist hit always
 * rejects; an allowlist (when present) must be matched by at least one sender.
 */
export class SenderPolicy {
  private constructor(
    private readonly exactAllowed: string[],
    private readonly exactBlocked: string[],
    private readonly domainAllowed: Domain[],
    private readonly domainBlocked: Domain[],
    private readonly hasAllowlist: boolean,
    private readonly hasAnyRule: boolean,
  ) {}

  static fromLists(
    allowed: string[] = [],
    blocked: string[] = [],
  ): SenderPolicy {
    const allowedSenders = allowed.map(normalizeEmail).filter(Boolean);
    const blockedSenders = blocked.map(normalizeEmail).filter(Boolean);
    return new SenderPolicy(
      allowedSenders.filter((e) => e.includes("@")),
      blockedSenders.filter((e) => e.includes("@")),
      toDomains(allowedSenders.filter((e) => !e.includes("@"))),
      toDomains(blockedSenders.filter((e) => !e.includes("@"))),
      allowedSenders.length > 0,
      allowedSenders.length > 0 || blockedSenders.length > 0,
    );
  }

  private evaluate(sender: string): SenderMatch {
    const parsed = EmailAddress.parse(sender);
    const normalized = parsed ? parsed.normalized : normalizeEmail(sender);
    const senderDomain = parsed?.domain ?? null;

    if (this.exactBlocked.includes(normalized)) return "blocked";
    if (this.exactAllowed.includes(normalized)) return "allowed";
    if (senderDomain && this.domainBlocked.some((d) => d.matches(senderDomain)))
      return "blocked";
    if (senderDomain && this.domainAllowed.some((d) => d.matches(senderDomain)))
      return "allowed";
    return "neutral";
  }

  /**
   * Decide whether an inbound email is accepted, given its candidate sender
   * addresses. A blocklist hit on any sender rejects; with an allowlist set, at
   * least one sender must match it.
   */
  decide(senders: string[]): SenderDecision {
    if (!this.hasAnyRule) return "accepted";

    const accepted = senders.some((sender) => {
      const decision = this.evaluate(sender);
      if (decision === "allowed") return true;
      if (decision === "blocked") return false;
      return !this.hasAllowlist;
    });

    return accepted ? "accepted" : "blocked";
  }
}
