import { Feed } from "feed";
import { FeedConfig, EmailData } from "../types";
import { processEmailContent, htmlToText } from "./html-processor";
import { EmailAddress } from "../domain/value-objects/email-address";
import { entryPath } from "./urls";

export { processEmailContent as extractBodyContent };

// XML 1.0 valid chars: #x9 #xA #xD #x20-#xD7FF #xE000-#xFFFD #x10000-#x10FFFF.
// A single illegal codepoint fails the whole feed parse in strict readers, so
// strip the complement before returning. The `u` flag iterates by code point, so
// valid surrogate pairs (emoji, …) survive while lone surrogates are removed.
function stripInvalidXmlChars(xml: string): string {
  return xml.replace(/[^\x09\x0A\x0D\x20-퟿-�\u{10000}-\u{10FFFF}]/gu, "");
}

function buildFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
  selfUrl?: { rss?: string; atom?: string; json?: string },
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
    // Public "website" for this feed: its own read URL (never the inbound address
    // or an auth-gated admin path, so the feed output leaks neither).
    link: `${baseUrl}/rss/${feedId}`,
    // WebSub hub advertised in the feed body (<atom:link rel="hub">). Readers like
    // FreshRSS discover the hub here, not from the HTTP Link header, so without it
    // they never subscribe and only refresh on cache expiry.
    hub: `${baseUrl}/hub`,
    language: feedConfig.language,
    updated: new Date(),
    generator: "kill-the-news",
    copyright: `Copyright © ${new Date().getFullYear()} ${feedConfig.title}`,
    feedLinks: {
      rss: selfUrl?.rss ?? `${baseUrl}/rss/${feedId}`,
      atom: selfUrl?.atom ?? `${baseUrl}/atom/${feedId}`,
      json: selfUrl?.json ?? `${baseUrl}/json/${feedId}`,
    },
    author: feedConfig.author
      ? {
          name: feedConfig.author,
          email: `noreply@${new URL(baseUrl).hostname}`,
        }
      : undefined,
  });

  for (const email of emails) {
    const entryUrl = `${baseUrl}${entryPath(feedId, email.receivedAt)}`;
    // Inline images are rendered in the body, not surfaced as an enclosure.
    const firstAttachment = email.attachments?.find((a) => !a.inline);
    const sender = EmailAddress.parse(email.from);
    const senderLabel = sender?.label() ?? email.from.trim();
    const bodyContent = processEmailContent(
      email.content,
      email.attachments,
      baseUrl,
      sender?.siteBaseUrl() ?? "",
    );
    const subject = htmlToText(email.subject);
    feed.addItem({
      title: feedConfig.sender_in_title
        ? `[${senderLabel}] ${subject}`
        : subject,
      id: entryUrl,
      link: entryUrl,
      description: bodyContent,
      content: bodyContent,
      author: [
        sender
          ? { name: senderLabel, email: sender.normalized }
          : { name: senderLabel },
      ],
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
  return stripInvalidXmlChars(
    buildFeed(
      feedConfig,
      emails,
      baseUrl,
      feedId,
      selfUrl ? { rss: selfUrl } : undefined,
    ).rss2(),
  );
}

export function generateAtomFeed(
  feedConfig: FeedConfig,
  emails: EmailData[],
  baseUrl: string,
  feedId: string,
  selfUrl?: string,
): string {
  return stripInvalidXmlChars(
    buildFeed(
      feedConfig,
      emails,
      baseUrl,
      feedId,
      selfUrl ? { atom: selfUrl } : undefined,
    ).atom1(),
  );
}

export function generateJsonFeed(
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
    selfUrl ? { json: selfUrl } : undefined,
  ).json1();
}
