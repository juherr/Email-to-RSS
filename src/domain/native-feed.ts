/**
 * Pure detection of a newsletter's own syndication feed. No DOM, no I/O — it
 * receives already-extracted <link> tuples (infra parses the HTML) and decides
 * which ones are real feeds. This module owns the business knowledge: the strict
 * set of recognized feed MIME types.
 */
import { NativeFeed } from "../types";

// MIME type → feed kind. Strict: only the three canonical syndication types.
// `application/json` is deliberately excluded — too broad, captures non-feeds.
const MIME_TO_KIND: Record<string, NativeFeed["type"]> = {
  "application/atom+xml": "atom",
  "application/rss+xml": "rss",
  "application/feed+json": "json",
};

// Drop MIME parameters ("; charset=…"), trim, lowercase.
function normalizeMime(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

/** Map raw <link> tuples to recognized native feeds, deduped by URL. */
export function detectNativeFeeds(
  links: { href: string; type: string }[],
): NativeFeed[] {
  const out: NativeFeed[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const kind = MIME_TO_KIND[normalizeMime(link.type)];
    if (!kind) continue;
    const url = link.href.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, type: kind });
  }
  return out;
}

/** Flatten per-sender native feeds into one list, deduped by URL (first wins). */
export function unionNativeFeeds(
  bySender: Record<string, NativeFeed[]> | undefined,
): NativeFeed[] {
  if (!bySender) return [];
  const out: NativeFeed[] = [];
  const seen = new Set<string>();
  for (const feeds of Object.values(bySender)) {
    for (const feed of feeds) {
      if (seen.has(feed.url)) continue;
      seen.add(feed.url);
      out.push({ ...feed });
    }
  }
  return out;
}
