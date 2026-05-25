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

// Strong URL signals: an unambiguous confirm/verify/activate action or a token.
// A link URL matching any scores +2.
const STRONG_LINK_SIGNALS = [
  "confirm",
  "verif",
  "activ",
  "valid",
  "bestatig",
  "aktivier",
  "optin",
  "opt-in",
  "double-optin",
  "token=",
  "confirm=",
  "activation",
];

// Weak signals: ambiguous subscribe/subscription words that also appear in
// ordinary "manage subscription" footers. Matched on the link href OR its visible
// text (a CTA button often reads "Yes, subscribe me…" / "Je m'inscris…" over an
// opaque tracking redirect). Worth only +1 — and only once, never href+text
// additively — so they cannot, on their own (with a stray body keyword), cross
// the threshold and cry wolf, yet still let a genuine "confirm your subscription"
// email pass. Multilingual like KEYWORDS (EN / FR / DE / ES) — extend per language.
const WEAK_LINK_SIGNALS = [
  "subscrib", // EN: subscribe / subscription (unsubscribe is caught by NEGATIVE first)
  "inscri", // FR: s'inscrire / inscription / je m'inscris
  "anmeld", // DE: anmelden / anmeldung
  "suscrib", // ES: suscribir / suscripción
  "inscrib", // ES: inscribirse / inscripción
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
  if (matchesAny(h, STRONG_LINK_SIGNALS)) score += 2;
  else if (matchesAny(h, WEAK_LINK_SIGNALS) || matchesAny(t, WEAK_LINK_SIGNALS))
    score += 1;
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

  // Dedupe by href before capping, so a link repeated in the body never wastes
  // one of the three surfaced slots.
  return [...new Set(candidates.map((c) => c.href))].slice(0, 3);
}
