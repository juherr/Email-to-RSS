import { Feed } from "feed";
import { FeedConfig, EmailData } from "../types";

function parseFromAddress(from: string): { name: string; email?: string } {
  const match = from.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    return { name: match[1].trim() || match[2], email: match[2].trim() };
  }
  const emailOnly = from.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/);
  if (emailOnly) {
    return { email: from.trim(), name: from.trim() };
  }
  return { name: from.trim() };
}

/**
 * Generate an RSS feed from a list of emails
 */
export function generateRssFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId?: string,
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
    const entryLink = feedId
      ? `${baseUrl}/entries/${feedId}/${email.receivedAt}`
      : `${baseUrl}/emails/${uniqueId}`;

    feed.addItem({
      title: email.subject,
      id: uniqueId,
      link: entryLink,
      description: email.content,
      content: email.content,
      author: [parseFromAddress(email.from)],
      date: date,
    });
  }

  // Return the RSS feed as XML
  return feed.rss2();
}
