/**
 * Pure detection of "confirm your subscription" emails. No DOM, no I/O — it
 * receives already-extracted subject/body text and link tuples (infra parses the
 * HTML). This module owns the business knowledge: the multilingual keyword vocab,
 * the link-signal patterns, the scoring weights and the threshold.
 *
 * Returns the ranked candidate confirmation links (top 3) when the combined score
 * clears the threshold AND at least one candidate link exists; otherwise null.
 * Only http(s) links are ever considered or returned.
 */

export interface DetectConfirmationInput {
  subject: string;
  text: string;
  links: { href: string; text: string }[];
}

// Confirmation-positive stems, already normalized (lowercased, diacritics stripped).
// EN / FR / DE / ES — extend here to add a language.
const KEYWORDS = [
  "confirm",
  "verif",
  "activ",
  "valid",
  "bestatig",
  "aktivier",
  "opt-in",
  "opt in",
  "optin",
];

// Link URL/anchor signals (normalized). A link matching any → candidate.
const LINK_SIGNALS = [
  "confirm",
  "verif",
  "activ",
  "valid",
  "bestatig",
  "aktivier",
  "optin",
  "opt-in",
  "double-optin",
  "subscription",
  "subscribe",
  "token=",
  "confirm=",
  "activation",
];

// Negative patterns: a link matching any of these is NEVER a candidate, and these
// tokens are stripped from text before keyword scanning (kills the unsubscribe
// false positive — "unsubscribe" contains "subscribe").
const NEGATIVE = [
  "unsubscribe",
  "desabonn",
  "desinscri",
  "abbestell",
  "opt-out",
  "optout",
  "list-unsubscribe",
];

const THRESHOLD = 3;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function isHttp(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function linkScore(href: string, text: string): number {
  const h = normalize(href);
  const t = normalize(text);
  if (matchesAny(h, NEGATIVE) || matchesAny(t, NEGATIVE)) return 0;
  let score = 0;
  if (matchesAny(h, LINK_SIGNALS)) score += 2;
  if (matchesAny(t, KEYWORDS)) score += 2;
  return score;
}

function stripNegatives(text: string): string {
  let out = text;
  for (const n of NEGATIVE) out = out.split(n).join(" ");
  return out;
}

export function detectConfirmation(
  input: DetectConfirmationInput,
): string[] | null {
  const candidates = input.links
    .filter((l) => isHttp(l.href))
    .map((l) => ({ href: l.href.trim(), score: linkScore(l.href, l.text) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  const subject = stripNegatives(normalize(input.subject));
  const text = stripNegatives(normalize(input.text));

  const subjectScore = matchesAny(subject, KEYWORDS) ? 2 : 0;
  const bodyScore = matchesAny(text, KEYWORDS) ? 1 : 0;
  const bestLinkScore = candidates[0].score;

  if (subjectScore + bodyScore + bestLinkScore < THRESHOLD) return null;

  return candidates.slice(0, 3).map((c) => c.href);
}
