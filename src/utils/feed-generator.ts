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

// Email content is stored as a full HTML document. Feed readers expect only
// the body fragment in <description>/<content:encoded>, not a full document.
export function extractBodyContent(html: string): string {
  const match = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  return match ? match[1] : html;
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
    // Computed dynamically so the id is always canonical regardless of what
    // was stored in KV at feed-creation time (which may have used a stale domain).
    id: `${baseUrl}/rss/${feedId}`,
    // Link points to the admin emails page — the "website" this feed represents.
    link: `${baseUrl}/admin/feeds/${feedId}/emails`,
    language: feedConfig.language,
    updated: new Date(),
    generator: "kill-the-news",
    copyright: `Copyright © ${new Date().getFullYear()} ${feedConfig.title}`,
    feedLinks: {
      rss: `${baseUrl}/rss/${feedId}`,
      atom: `${baseUrl}/atom/${feedId}`,
    },
    author: feedConfig.author
      ? {
          name: feedConfig.author,
          email: `noreply@${new URL(baseUrl).hostname}`,
        }
      : undefined,
  });

  for (const email of emails) {
    const uniqueId = `${email.receivedAt}-${Buffer.from(email.subject).toString("base64").substring(0, 10)}`;
    const firstAttachment = email.attachments?.[0];
    const bodyContent = extractBodyContent(email.content);
    feed.addItem({
      title: email.subject,
      id: uniqueId,
      link: `${baseUrl}/entries/${feedId}/${email.receivedAt}`,
      description: bodyContent,
      content: bodyContent,
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
