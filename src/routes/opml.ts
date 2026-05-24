import { Context } from "hono";
import { Env } from "../types";
import { FeedRepository } from "../infrastructure/feed-repository";
import { feedRssUrl } from "../infrastructure/urls";

/**
 * Escape a string for use in an XML attribute value.
 * Replaces &, <, >, and " with their XML entity equivalents.
 */
function escapeXmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Handler for GET /admin/opml
 * Exports all feeds as an OPML 2.0 document.
 * Protected by the admin auth middleware (inherits from admin Hono app).
 */
export async function handleOpml(c: Context<{ Bindings: Env }>) {
  const env = c.env;
  const feeds = await FeedRepository.from(env).listFeeds();

  const outlines = feeds
    .map((feed) => {
      const title = escapeXmlAttr(feed.title);
      const xmlUrl = escapeXmlAttr(feedRssUrl(feed.id, env));
      const descAttr = feed.description
        ? ` description="${escapeXmlAttr(feed.description)}"`
        : "";
      return `    <outline type="rss" text="${title}" title="${title}" xmlUrl="${xmlUrl}"${descAttr}/>`;
    })
    .join("\n");

  const opml = `<?xml version="1.0" encoding="UTF-8"?>
<opml version="2.0">
  <head>
    <title>kill-the-news feeds</title>
  </head>
  <body>
${outlines}
  </body>
</opml>`;

  return new Response(opml, {
    status: 200,
    headers: {
      "Content-Type": "text/x-opml; charset=utf-8",
      "Content-Disposition": 'attachment; filename="feeds.opml"',
      "X-Robots-Tag": "noindex",
    },
  });
}
