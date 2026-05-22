import { Context } from "hono";
import { Env } from "../types";
import { generateRssFeed } from "../utils/feed-generator";
import { fetchFeedData } from "../utils/feed-fetcher";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const feedId = c.req.param("feedId");
    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    const feedData = await fetchFeedData(feedId, c.env, "rss");
    if (!feedData) {
      return new Response("Feed not found", { status: 404 });
    }

    const baseUrl = `https://${c.env.DOMAIN}`;
    const rssXml = generateRssFeed(
      feedData.feedConfig,
      feedData.emails,
      baseUrl,
      feedId,
    );
    const linkHeader = [
      `<${baseUrl}/hub>; rel="hub"`,
      `<${baseUrl}/rss/${feedId}>; rel="self"`,
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
