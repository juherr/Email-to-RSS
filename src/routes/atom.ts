import { Context } from "hono";
import { Env } from "../types";
import { generateAtomFeed } from "../infrastructure/feed-generator";
import { fetchFeedData } from "../application/feed-fetcher";
import { baseUrl, feedAtomUrl } from "../infrastructure/urls";
import { isExpired } from "../domain/feed";

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
    if (isExpired(feedData.feedConfig)) {
      return new Response("Feed has expired", { status: 410 });
    }

    const base = baseUrl(c.env);
    const selfUrl = new URL(c.req.url).origin + `/atom/${feedId}`;
    const atomXml = generateAtomFeed(
      feedData.feedConfig,
      feedData.emails,
      base,
      feedId,
      selfUrl,
    );
    const linkHeader = [
      `<${base}/hub>; rel="hub"`,
      `<${feedAtomUrl(feedId, c.env)}>; rel="self"`,
    ].join(", ");

    return new Response(atomXml, {
      status: 200,
      headers: {
        "Content-Type": "application/atom+xml",
        "Cache-Control": "max-age=1800",
        Link: linkHeader,
      },
    });
  } catch (error) {
    console.error("Error generating Atom feed:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
