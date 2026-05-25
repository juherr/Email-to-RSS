import { Context } from "hono";
import { Env } from "../types";
import { generateRssFeed } from "../infrastructure/feed-generator";
import { fetchFeedData } from "../application/feed-fetcher";
import { baseUrl, feedRssUrl } from "../infrastructure/urls";
import { isExpired } from "../domain/feed";
import { FeedId } from "../domain/value-objects/feed-id";
import {
  computeFeedValidators,
  isNotModified,
  notModifiedResponse,
} from "../infrastructure/http-cache";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const feedId = c.req.param("feedId");
    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    const feedData = await fetchFeedData(FeedId.unchecked(feedId), c.env);
    if (!feedData) {
      return new Response("Feed not found", { status: 404 });
    }
    if (isExpired(feedData.feedConfig)) {
      return new Response("Feed has expired", { status: 410 });
    }

    const validators = computeFeedValidators(
      "rss",
      feedId,
      feedData.feedConfig,
      feedData.emails,
    );

    if (isNotModified(c.req.raw, validators)) {
      return notModifiedResponse(validators);
    }

    const base = baseUrl(c.env);
    const selfUrl = feedRssUrl(feedId, c.env);
    const rssXml = generateRssFeed(
      feedData.feedConfig,
      feedData.emails,
      base,
      feedId,
      selfUrl,
    );
    const linkHeader = [
      `<${base}/hub>; rel="hub"`,
      `<${feedRssUrl(feedId, c.env)}>; rel="self"`,
    ].join(", ");

    return new Response(rssXml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml",
        "Cache-Control": "max-age=1800",
        "X-Robots-Tag": "noindex",
        Link: linkHeader,
        ETag: validators.etag,
        "Last-Modified": validators.lastModified,
      },
    });
  } catch (error) {
    console.error("Error generating RSS feed:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
