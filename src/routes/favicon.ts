import { Context } from "hono";
import { Env } from "../types";
import { FeedRepository } from "../domain/feed-repository";
import { FeedId } from "../domain/value-objects/feed-id";
import { cacheFaviconForDomain, getCachedIcon } from "../utils/favicon-fetcher";

export const FAVICON_PATH = "/favicon.svg";

// Project favicon — reuses the header's envelope logo (brand orange #f6821f),
// rendered as a white envelope on a rounded orange square for legibility at 16px.
export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <rect width="32" height="32" rx="7" fill="#f6821f"/>
  <g fill="none" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
    <path d="M7 9h18c1.1 0 2 .9 2 2v10c0 1.1-.9 2-2 2H7c-1.1 0-2-.9-2-2V11c0-1.1.9-2 2-2z"/>
    <polyline points="27,11 16,18.5 5,11"/>
  </g>
</svg>`;

function projectFavicon(): Response {
  return new Response(FAVICON_SVG, {
    headers: {
      "Content-Type": "image/svg+xml; charset=utf-8",
      "Cache-Control": "public, max-age=86400",
    },
  });
}

export function handle(_c: Context<{ Bindings: Env }>): Response {
  return projectFavicon();
}

/**
 * Per-feed favicon. Resolves the feed's most recent sender domain and serves
 * its cached icon; falls back to the project icon for any unresolved case
 * (no domain, cache miss, or negative cache entry).
 */
export async function handleFeedFavicon(
  c: Context<{ Bindings: Env }>,
): Promise<Response> {
  const env = c.env;
  const feedId = c.req.param("feedId");
  if (!feedId) return projectFavicon();

  const metadata = await FeedRepository.from(env).getMetadata(
    FeedId.fromTrusted(feedId),
  );
  const domain = metadata?.iconDomain;
  if (!domain) return projectFavicon();

  const icon = await getCachedIcon(domain, env);
  if (icon) {
    return new Response(icon.bytes, {
      headers: {
        "Content-Type": icon.contentType,
        "Cache-Control": "public, max-age=86400",
      },
    });
  }

  // Known domain but nothing cached yet: warm the cache in the background and
  // serve the fallback for now.
  try {
    c.executionCtx.waitUntil(cacheFaviconForDomain(domain, env));
  } catch {
    // No ExecutionContext (e.g. tests) — fallback is served regardless.
  }
  return projectFavicon();
}
