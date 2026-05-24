import { Env } from "../types";
import { MailboxId } from "../domain/value-objects/mailbox-id";

export function baseUrl(env: Env): string {
  return `https://${env.DOMAIN}`;
}

export function feedRssUrl(feedId: string, env: Env): string {
  return `${baseUrl(env)}/rss/${feedId}`;
}

export function feedAtomUrl(feedId: string, env: Env): string {
  return `${baseUrl(env)}/atom/${feedId}`;
}

export function feedJsonUrl(feedId: string, env: Env): string {
  return `${baseUrl(env)}/json/${feedId}`;
}

export function feedUrl(
  format: "rss" | "atom",
  feedId: string,
  env: Env,
): string {
  return format === "rss" ? feedRssUrl(feedId, env) : feedAtomUrl(feedId, env);
}

export type FeedFormat = "rss" | "atom" | "json";

export function feedFormatUrl(
  format: FeedFormat,
  feedId: string,
  env: Env,
): string {
  if (format === "atom") return feedAtomUrl(feedId, env);
  if (format === "json") return feedJsonUrl(feedId, env);
  return feedRssUrl(feedId, env);
}

/**
 * Link to a third-party validator for the public feed URL: the W3C Feed
 * Validator for RSS/Atom, validator.jsonfeed.org for JSON Feed. Used in the
 * admin UI so an operator can confirm a feed parses in real readers.
 */
export function feedValidatorUrl(
  format: FeedFormat,
  feedId: string,
  env: Env,
): string {
  const encoded = encodeURIComponent(feedFormatUrl(format, feedId, env));
  return format === "json"
    ? `https://validator.jsonfeed.org/?url=${encoded}`
    : `https://validator.w3.org/feed/check.cgi?url=${encoded}`;
}

export function feedEmailAddress(mailboxId: string, env: Env): string {
  // The mailbox→address shape lives on the VO; this edge only resolves the domain.
  return MailboxId.unchecked(mailboxId).emailAddress(
    env.EMAIL_DOMAIN ?? env.DOMAIN,
  );
}

export function feedTopicPattern(env: Env): RegExp {
  const escaped = env.DOMAIN.replaceAll(".", "\\.");
  return new RegExp(`^https://${escaped}/(rss|atom)/([^/]+)$`);
}
