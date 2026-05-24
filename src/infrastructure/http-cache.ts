import { FeedConfig, EmailData } from "../types";

export interface FeedValidators {
  etag: string;
  lastModified: string;
  maxReceivedAt: number;
}

/**
 * Compute HTTP cache validators (ETag + Last-Modified) for a feed.
 * The ETag is derived from the feed format prefix, feedId, email count, and max
 * receivedAt, making it a strong deterministic validator that changes whenever
 * the feed content changes.
 */
export function computeFeedValidators(
  format: "rss" | "atom",
  feedId: string,
  feedConfig: FeedConfig,
  emails: EmailData[],
): FeedValidators {
  const maxReceivedAt =
    emails.length > 0
      ? Math.max(...emails.map((e) => e.receivedAt))
      : (feedConfig.created_at ?? 0);

  const hash = `${format}-${feedId}-${emails.length}-${maxReceivedAt}`;
  const etag = `"${hash}"`;
  const lastModified = new Date(maxReceivedAt).toUTCString();

  return { etag, lastModified, maxReceivedAt };
}

/**
 * Returns true if the request carries a matching conditional GET header,
 * meaning a 304 Not Modified response is appropriate.
 */
export function isNotModified(
  req: Request,
  validators: FeedValidators,
): boolean {
  const ifNoneMatch = req.headers.get("If-None-Match");
  if (ifNoneMatch !== null) {
    return ifNoneMatch === validators.etag;
  }

  const ifModifiedSince = req.headers.get("If-Modified-Since");
  if (ifModifiedSince !== null) {
    const clientTime = new Date(ifModifiedSince).getTime();
    return !isNaN(clientTime) && clientTime >= validators.maxReceivedAt;
  }

  return false;
}

/**
 * Build a 304 Not Modified response with the standard cache validator headers.
 */
export function notModifiedResponse(validators: FeedValidators): Response {
  return new Response(null, {
    status: 304,
    headers: {
      ETag: validators.etag,
      "Last-Modified": validators.lastModified,
      "Cache-Control": "max-age=1800",
      "X-Robots-Tag": "noindex",
    },
  });
}
