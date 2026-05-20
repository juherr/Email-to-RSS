import { Context } from "hono";
import { Env, FeedConfig, FeedMetadata, EmailData } from "../types";
import { generateRssFeed } from "../utils/feed-generator";

/**
 * Generates an RSS feed for a specific feed ID
 */
export async function handle(c: Context): Promise<Response> {
  try {
    // Type assertion for environment variables
    const env = c.env as unknown as Env;

    // Extract the feed ID from the route params
    const feedId = c.req.param("feedId");

    if (!feedId) {
      return new Response("Feed ID is required", { status: 400 });
    }

    // Get the KV namespace
    const emailStorage = env.EMAIL_STORAGE;

    // Check if the feed exists
    const feedMetadataKey = `feed:${feedId}:metadata`;
    const feedMetadata = (await emailStorage.get(
      feedMetadataKey,
      "json",
    )) as FeedMetadata | null;

    if (!feedMetadata) {
      return new Response("Feed not found", { status: 404 });
    }

    // Get feed configuration (title, description, etc.)
    const feedConfigKey = `feed:${feedId}:config`;
    const feedConfig = ((await emailStorage.get(
      feedConfigKey,
      "json",
    )) as FeedConfig | null) || {
      title: `Newsletter Feed ${feedId}`,
      description: "Converted email newsletter",
      site_url: `https://${env.DOMAIN}/rss/${feedId}`,
      feed_url: `https://${env.DOMAIN}/rss/${feedId}`,
      language: "en",
      created_at: Date.now(),
    };

    // Get the emails for this feed (up to the last 20)
    const emails = feedMetadata.emails.slice(0, 20);
    const emailsData: EmailData[] = [];

    // Fetch all email content
    for (const email of emails) {
      const emailData = (await emailStorage.get(
        email.key,
        "json",
      )) as EmailData | null;
      if (emailData) {
        emailsData.push(emailData);
      }
    }

    // Generate the RSS feed XML
    const baseUrl = `https://${env.DOMAIN}`;
    const rssXml = generateRssFeed(feedConfig, emailsData, baseUrl, feedId);

    // Return the RSS feed with appropriate content type
    return new Response(rssXml, {
      status: 200,
      headers: {
        "Content-Type": "application/rss+xml",
        "Cache-Control": "max-age=1800", // 30 minutes cache
      },
    });
  } catch (error) {
    console.error("Error generating RSS feed:", error);
    return new Response("Internal Server Error", { status: 500 });
  }
}
