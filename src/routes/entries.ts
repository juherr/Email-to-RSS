import { Context } from "hono";
import { html, raw } from "hono/html";
import { Env, FeedMetadata, EmailData } from "../types";
import { processEmailContent } from "../utils/html-processor";

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  const feedId = c.req.param("feedId");
  const receivedAt = parseInt(c.req.param("entryId") ?? "", 10);

  if (!feedId || isNaN(receivedAt)) {
    return new Response("Not Found", { status: 404 });
  }

  const emailStorage = c.env.EMAIL_STORAGE;

  const feedMetadata = (await emailStorage.get(
    `feed:${feedId}:metadata`,
    "json",
  )) as FeedMetadata | null;
  if (!feedMetadata) {
    return new Response("Feed not found", { status: 404 });
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
        </body>
      </html>`,
  );
}
