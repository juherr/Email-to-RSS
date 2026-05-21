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

function buildFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
): Feed {
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
      rss: `${baseUrl}/rss/${feedId}`,
      atom: `${baseUrl}/atom/${feedId}`,
    },
    author: feedConfig.author
      ? {
          name: feedConfig.author,
          email: `noreply@${new URL(feedConfig.site_url).hostname}`,
        }
      : undefined,
  });

  for (const email of emails) {
    const uniqueId = `${email.receivedAt}-${Buffer.from(email.subject).toString("base64").substring(0, 10)}`;
    const firstAttachment = email.attachments?.[0];
    feed.addItem({
      title: email.subject,
      id: uniqueId,
      link: `${baseUrl}/entries/${feedId}/${email.receivedAt}`,
      description: email.content,
      content: email.content,
      author: [parseFromAddress(email.from)],
      date: new Date(email.receivedAt),
      enclosure: firstAttachment
        ? {
            url: `${baseUrl}/files/${firstAttachment.id}/${encodeURIComponent(firstAttachment.filename)}`,
            type: firstAttachment.contentType,
            length: firstAttachment.size,
          }
        : undefined,
    });
  }

  return feed;
}

export function generateRssFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
): string {
  return buildFeed(feedConfig, emails, baseUrl, feedId).rss2();
}

export function generateAtomFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
): string {
  return buildFeed(feedConfig, emails, baseUrl, feedId).atom1();
}
