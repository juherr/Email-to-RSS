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
  const withClose = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = withClose
    ? withClose[1]
    : (() => {
        const withoutClose = html.match(/<body[^>]*>([\s\S]*)/i);
        return withoutClose
          ? withoutClose[1].replace(/<\/html>\s*$/i, "")
          : html;
      })();
  // Strip mso-* properties from inline styles (Office HTML — triggers feed validator warnings)
  return body.replace(/\bstyle="([^"]*)"/gi, (_match, style: string) => {
    const cleaned = style
      .split(";")
      .map((p) => p.trim())
      .filter((p) => p && !/^mso-/i.test(p))
      .join("; ");
    return cleaned ? `style="${cleaned}"` : "";
  });
}

function buildFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
  selfUrl?: { rss?: string; atom?: string },
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
    const firstAttachment = email.attachments?.[0];
    const bodyContent = extractBodyContent(email.content);
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
