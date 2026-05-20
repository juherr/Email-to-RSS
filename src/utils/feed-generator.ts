import { Feed } from "feed";
import { FeedConfig, EmailData } from "../types";

/**
 * Generate an RSS feed from a list of emails
 */
export function generateRssFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
): string {
  // Create a new feed
  const feed = new Feed({
    title: feedConfig.title,
    description: feedConfig.description || "",
    id: feedConfig.feed_url,
    link: feedConfig.site_url,
    language: feedConfig.language,
    updated: new Date(),
    generator: "Email-to-RSS",
    copyright: `Copyright © ${new Date().getFullYear()} ${feedConfig.title}`,
    feedLinks: {
      rss: feedConfig.feed_url,
    },
    author: feedConfig.author
      ? {
          name: feedConfig.author,
          email: `noreply@${new URL(feedConfig.site_url).hostname}`,
        }
      : undefined,
  });

  // Add each email as a feed item
  for (const email of emails) {
    const date = new Date(email.receivedAt);
    const uniqueId = `${email.receivedAt}-${Buffer.from(email.subject).toString("base64").substring(0, 10)}`;

    feed.addItem({
      title: email.subject,
      id: uniqueId,
      link: `${baseUrl}/emails/${uniqueId}`,
      description: email.content,
      content: email.content,
      author: [
        {
          name: email.from,
        },
      ],
      date: date,
    });
  }

  // Return the RSS feed as XML
  return feed.rss2();
}
