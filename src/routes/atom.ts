import { Context } from "hono";
import { Env, FeedConfig, FeedMetadata, EmailData } from "../types";
import { generateAtomFeed } from "../utils/feed-generator";

export async function handle(c: Context): Promise<Response> {
  try {
    const env = c.env as unknown as Env;

    const feedId = c.req.param("feedId");

    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    const emailStorage = env.EMAIL_STORAGE;

    const feedMetadata = (await emailStorage.get(
      `feed:${feedId}:metadata`,
      "json",
    )) as FeedMetadata | null;

    if (!feedMetadata) {
      return new Response("Feed not found", { status: 404 });
    }

    const feedConfig = ((await emailStorage.get(
      `feed:${feedId}:config`,
      "json",
    )) as FeedConfig | null) || {
      title: `Newsletter Feed ${feedId}`,
      description: "Converted email newsletter",
      site_url: `https://${env.DOMAIN}/atom/${feedId}`,
      feed_url: `https://${env.DOMAIN}/atom/${feedId}`,
      language: "en",
      created_at: Date.now(),
    };

    const emails = feedMetadata.emails.slice(0, 20);
    const emailsData: EmailData[] = [];

    for (const email of emails) {
      const emailData = (await emailStorage.get(
        email.key,
        "json",
      )) as EmailData | null;
      if (emailData) {
        emailsData.push(emailData);
      }
    }

    const baseUrl = `https://${env.DOMAIN}`;
    const atomXml = generateAtomFeed(feedConfig, emailsData, baseUrl, feedId);

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
