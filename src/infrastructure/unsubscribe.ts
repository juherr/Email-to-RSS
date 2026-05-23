import { Env } from "../types";
import { UNSUBSCRIBE_TIMEOUT_MS } from "../config/constants";
import { bumpCounters } from "../application/stats";
import { logger } from "../infrastructure/logger";

/**
 * Extract a one-click unsubscribe URL from a stored email's headers per
 * RFC 8058. Returns the first `https:` URL in `List-Unsubscribe` only when
 * `List-Unsubscribe-Post: List-Unsubscribe=One-Click` is also present — that
 * Post header is what authorises an unattended one-click POST. `mailto:` and
 * plaintext `http:` links are ignored (Workers cannot send SMTP and we never
 * unsubscribe over plaintext). Header keys are matched case-insensitively;
 * `EmailData.headers` already lowercases them, but we don't rely on it.
 */
export function parseOneClickUnsubscribe(
  headers: Record<string, string>,
): string | null {
  let listUnsubscribe = "";
  let post = "";
  for (const [key, value] of Object.entries(headers)) {
    const k = key.toLowerCase();
    if (k === "list-unsubscribe") listUnsubscribe = value;
    else if (k === "list-unsubscribe-post") post = value;
  }

  if (post.trim().toLowerCase() !== "list-unsubscribe=one-click") return null;

  const matches = listUnsubscribe.match(/<([^>]+)>/g);
  if (!matches) return null;
  for (const token of matches) {
    const url = token.slice(1, -1).trim();
    if (/^https:\/\//i.test(url)) return url;
  }
  return null;
}

/**
 * Fire a single RFC 8058 one-click unsubscribe POST. Returns whether the
 * endpoint accepted it. Never throws: network/timeout errors are logged and
 * reported as a failure so callers can keep going.
 */
export async function sendOneClickUnsubscribe(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "POST",
      redirect: "follow",
      signal: AbortSignal.timeout(UNSUBSCRIBE_TIMEOUT_MS),
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "User-Agent": "kill-the-news/1.0",
      },
      body: "List-Unsubscribe=One-Click",
    });
    return res.ok;
  } catch (error) {
    logger.warn("One-click unsubscribe failed", { url, error: String(error) });
    return false;
  }
}

/**
 * Send one-click unsubscribe requests for a batch of URLs (de-duplicated) and
 * record the number that succeeded in the `unsubscribes_sent` counter. Never
 * throws — intended to run in the background via ctx.waitUntil on feed deletion.
 */
export async function sendUnsubscribes(
  urls: string[],
  env: Env,
): Promise<void> {
  const unique = Array.from(new Set(urls.filter(Boolean)));
  if (unique.length === 0) return;

  const results = await Promise.allSettled(
    unique.map((url) => sendOneClickUnsubscribe(url)),
  );
  const succeeded = results.filter(
    (r) => r.status === "fulfilled" && r.value,
  ).length;

  if (succeeded > 0) {
    await bumpCounters(env.EMAIL_STORAGE, { unsubscribes_sent: succeeded });
  }
}
