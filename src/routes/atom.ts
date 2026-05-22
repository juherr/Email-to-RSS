import { Context } from "hono";
import { Env } from "../types";
import { generateAtomFeed } from "../utils/feed-generator";
import { fetchFeedData } from "../utils/feed-fetcher";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  try {
    const feedId = c.req.param("feedId");
    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    const feedData = await fetchFeedData(feedId, c.env, "atom");
    if (!feedData) {
      return new Response("Feed not found", { status: 404 });
    }

    const baseUrl = `https://${c.env.DOMAIN}`;
    const atomXml = generateAtomFeed(
      feedData.feedConfig,
      feedData.emails,
      baseUrl,
      feedId,
    );
    const linkHeader = [
      `<${baseUrl}/hub>; rel="hub"`,
      `<${baseUrl}/atom/${feedId}>; rel="self"`,
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
