import { Env } from "../types";

export function baseUrl(env: Env): string {
  return `https://${env.DOMAIN}`;
}

export function feedRssUrl(feedId: string, env: Env): string {
  return `${baseUrl(env)}/rss/${feedId}`;
}

export function feedAtomUrl(feedId: string, env: Env): string {
  return `${baseUrl(env)}/atom/${feedId}`;
}

export function feedUrl(
  format: "rss" | "atom",
  feedId: string,
  env: Env,
): string {
  return format === "rss" ? feedRssUrl(feedId, env) : feedAtomUrl(feedId, env);
}

export function feedEmailAddress(feedId: string, env: Env): string {
  return `${feedId}@${env.EMAIL_DOMAIN ?? env.DOMAIN}`;
}

export function feedTopicPattern(env: Env): RegExp {
  const escaped = env.DOMAIN.replaceAll(".", "\\.");
  return new RegExp(`^https://${escaped}/(rss|atom)/([^/]+)$`);
}
