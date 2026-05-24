import { Feed } from "feed";
import { FeedConfig, EmailData } from "../types";
import { processEmailContent } from "./html-processor";

export { processEmailContent as extractBodyContent };

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
  selfUrl?: { rss?: string; atom?: string },
): Feed {
  const iconUrl = `${baseUrl}/favicon/${feedId}`;
  const feed = new Feed({
    title: feedConfig.title,
    description: feedConfig.description || "",
    // Per-feed icon derived from the last sender's domain (self-falls-back to
    // the project icon). image → RSS <image>/Atom <logo>; favicon → Atom <icon>.
    image: iconUrl,
    favicon: iconUrl,
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
      rss: selfUrl?.rss ?? `${baseUrl}/rss/${feedId}`,
      atom: selfUrl?.atom ?? `${baseUrl}/atom/${feedId}`,
    },
    author: feedConfig.author
      ? {
          name: feedConfig.author,
          email: `noreply@${new URL(baseUrl).hostname}`,
        }
      : undefined,
  });

  for (const email of emails) {
    const entryUrl = `${baseUrl}/entries/${feedId}/${email.receivedAt}`;
    // Inline images are rendered in the body, not surfaced as an enclosure.
    const firstAttachment = email.attachments?.find((a) => !a.inline);
    const bodyContent = processEmailContent(
      email.content,
      email.attachments,
      baseUrl,
    );
    feed.addItem({
      title: email.subject,
      id: entryUrl,
      link: entryUrl,
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
  selfUrl?: string,
): string {
  return buildFeed(
    feedConfig,
    emails,
    baseUrl,
    feedId,
    selfUrl ? { rss: selfUrl } : undefined,
  ).rss2();
}

export function generateAtomFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
  selfUrl?: string,
): string {
  return buildFeed(
    feedConfig,
    emails,
    baseUrl,
    feedId,
    selfUrl ? { atom: selfUrl } : undefined,
  ).atom1();
}
