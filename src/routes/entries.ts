import { Context } from "hono";
import { Env, FeedMetadata, EmailData } from "../types";
import { escapeHtml } from "../utils/html";

export async function handle(c: Context): Promise<Response> {
  const env = c.env as unknown as Env;
  const feedId = c.req.param("feedId");
  const receivedAt = parseInt(c.req.param("entryId"), 10);

  if (!feedId || isNaN(receivedAt)) {
    return new Response("Not Found", { status: 404 });
  }

  const emailStorage = env.EMAIL_STORAGE;

  const feedMetadata = (await emailStorage.get(
    `feed:${feedId}:metadata`,
    "json",
  )) as FeedMetadata | null;
  if (!feedMetadata) {
    return new Response("Feed not found", { status: 404 });
  }

  const metaEntry = feedMetadata.emails.find((e) => e.receivedAt === receivedAt);
  if (!metaEntry) {
    return new Response("Entry not found", { status: 404 });
  }

  const emailData = (await emailStorage.get(
    metaEntry.key,
    "json",
  )) as EmailData | null;
  if (!emailData) {
    return new Response("Entry not found", { status: 404 });
  }

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(emailData.subject)}</title>
  <style>
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 1rem; }
    .meta { color: #666; font-size: 0.875rem; margin-bottom: 1.5rem; border-bottom: 1px solid #eee; padding-bottom: 0.75rem; }
    .meta dt { display: inline; font-weight: bold; }
    .meta dd { display: inline; margin: 0 1rem 0 0.25rem; }
  </style>
</head>
<body>
  <h1>${escapeHtml(emailData.subject)}</h1>
  <dl class="meta">
    <dt>From:</dt><dd>${escapeHtml(emailData.from)}</dd>
    <dt>Date:</dt><dd>${escapeHtml(new Date(emailData.receivedAt).toUTCString())}</dd>
  </dl>
  <div class="content">${emailData.content}</div>
</body>
</html>`;

  return new Response(html, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; img-src *; frame-src 'none'",
    },
  });
}
