import { Context } from "hono";
import { html, raw } from "hono/html";
import { Env, FeedConfig, FeedMetadata, EmailData } from "../types";
import { processEmailContent } from "../utils/html-processor";
import { formatBytes } from "../utils/format";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  const feedId = c.req.param("feedId");
  const receivedAt = parseInt(c.req.param("entryId") ?? "", 10);

  if (!feedId || isNaN(receivedAt)) {
    return new Response("Not Found", { status: 404 });
  }

  const emailStorage = c.env.EMAIL_STORAGE;

  const [feedMetadata, feedConfig] = await Promise.all([
    emailStorage.get(
      `feed:${feedId}:metadata`,
      "json",
    ) as Promise<FeedMetadata | null>,
    emailStorage.get(
      `feed:${feedId}:config`,
      "json",
    ) as Promise<FeedConfig | null>,
  ]);
  if (!feedMetadata) {
    return new Response("Feed not found", { status: 404 });
  }
  if (
    feedConfig?.expires_at !== undefined &&
    feedConfig.expires_at <= Date.now()
  ) {
    return new Response("Feed has expired", { status: 410 });
  }

  const metaEntry = feedMetadata.emails.find(
    (e) => e.receivedAt === receivedAt,
  );
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

  c.header(
    "Content-Security-Policy",
    "default-src 'none'; style-src 'unsafe-inline'; img-src *; frame-src 'none'",
  );

  const attachments = emailData.attachments ?? [];
  const attachmentsSection = attachments.length
    ? html`<section class="attachments">
        <h2>Attachments</h2>
        <ul>
          ${attachments.map(
            (a) =>
              html`<li>
                <a
                  href="/files/${a.id}/${encodeURIComponent(a.filename)}"
                  download
                  >${a.filename}</a
                >
                <span class="size">${formatBytes(a.size)}</span>
              </li>`,
          )}
        </ul>
      </section>`
    : "";

  return c.html(
    html`<!DOCTYPE html>
      <html>
        <head>
          <meta charset="UTF-8" />
          <meta
            name="viewport"
            content="width=device-width, initial-scale=1.0"
          />
          <title>${emailData.subject}</title>
          <link rel="icon" type="image/svg+xml" href="/favicon.svg" />
          <style>
            body {
              font-family: sans-serif;
              max-width: 800px;
              margin: 0 auto;
              padding: 1rem;
            }
            .meta {
              color: #666;
              font-size: 0.875rem;
              margin-bottom: 1.5rem;
              border-bottom: 1px solid #eee;
              padding-bottom: 0.75rem;
            }
            .meta dt {
              display: inline;
              font-weight: bold;
            }
            .meta dd {
              display: inline;
              margin: 0 1rem 0 0.25rem;
            }
            .attachments {
              margin-top: 2rem;
              border-top: 1px solid #eee;
              padding-top: 1rem;
            }
            .attachments h2 {
              font-size: 1rem;
              margin: 0 0 0.5rem;
            }
            .attachments ul {
              list-style: none;
              padding: 0;
              margin: 0;
            }
            .attachments li {
              margin: 0.25rem 0;
            }
            .attachments .size {
              color: #666;
              font-size: 0.875rem;
              margin-left: 0.5rem;
            }
          </style>
        </head>
        <body>
          <h1>${emailData.subject}</h1>
          <dl class="meta">
            <dt>From:</dt>
            <dd>${emailData.from}</dd>
            <dt>Date:</dt>
            <dd>${new Date(emailData.receivedAt).toUTCString()}</dd>
          </dl>
          <div class="content">
            ${raw(processEmailContent(emailData.content))}
          </div>
          ${attachmentsSection}
        </body>
      </html>`,
  );
}
