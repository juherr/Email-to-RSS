import { Context } from "hono";
import { Env } from "../types";
import { generateRssFeed } from "../utils/feed-generator";
import { fetchFeedData } from "../utils/feed-fetcher";
import { baseUrl, feedRssUrl } from "../utils/urls";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const feedId = c.req.param("feedId");
    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    const feedData = await fetchFeedData(feedId, c.env);
    if (!feedData) {
      return new Response("Feed not found", { status: 404 });
    }

    const base = baseUrl(c.env);
    const selfUrl = new URL(c.req.url).origin + `/rss/${feedId}`;
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
        Link: linkHeader,
      },
    });
  } catch (error) {
    console.error("Error generating RSS feed:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
