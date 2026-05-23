# TODO

Feature gaps identified by comparing with [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter).

## Quick wins

- [x] **Author field in RSS entries** — expose the `from` address as `<author>` in each RSS `<item>`. The value is already stored in KV, just not rendered in the feed XML.

- [x] **HTML view for individual entries** — serve each email as an HTML page at e.g. `/entries/:feedId/:timestamp`. Useful for reading emails outside a feed reader and for debugging. kill-the-newsletter serves these at `/feeds/{feedId}/entries/{entryId}.html` with a Content-Security-Policy header.

- [x] **JSON API for feed creation** — accept `Content-Type: application/json` on `POST /admin/feeds` and return `{ feedId, email, feedUrl }`. Useful for automation (e.g. Tofu/OpenTofu provisioning).

- [ ] **Project favicon** — serve a single bundled icon at `/favicon.ico` and add a `<link rel="icon">` in the shared `Layout` so the admin UI, status page, and entry views stop 404-ing. Doubles as the default/fallback icon for the per-feed favicon feature below.

## Medium effort

- [x] **Size-based feed trimming** — instead of a fixed 50-entry cap, drop the oldest entries when the feed exceeds a size threshold (kill-the-newsletter uses ~512 KB). More robust for HTML-heavy newsletters where one entry can dominate.

- [x] **Atom feed format** — expose feeds as Atom (`application/atom+xml`) in addition to or instead of RSS 2.0. Atom has better native support for HTML content and author metadata.

- [x] **Authelia / external auth provider support** — allow delegating admin authentication to an external identity provider (e.g. Authelia, Authentik) via a trusted header (`Remote-User`, `X-Forwarded-User`) set by a reverse proxy. The Worker would accept the header as proof of authentication instead of checking the cookie, with a configurable secret or IP allowlist to trust only the proxy.

- [ ] **Per-feed favicon from the last sender's domain** — give each feed an icon by fetching the favicon of the last sender's domain, so feeds are visually distinguishable in readers and the admin UI. Resolve the domain from the most recent email's `from`, fetch its favicon (e.g. `https://<domain>/favicon.ico` or a parsed `<link rel="icon">`, with a fallback service), and cache the result aggressively (KV/R2 + Cache API with a long TTL) so it isn't re-fetched on every request. Expose it via the RSS `<image>` / Atom `<icon>` and the admin feed list.

- [ ] **RFC 8058 one-click unsubscribe on feed deletion** — when a feed is deleted, automatically unsubscribe from the newsletters that fed it so messages stop arriving at the now-dead address. Parse and store the `List-Unsubscribe` / `List-Unsubscribe-Post` headers ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.txt)) from incoming emails, then on deletion POST `List-Unsubscribe=One-Click` to each stored unsubscribe URL. Requires capturing the headers during ingestion (`src/lib/email-processor.ts`) and firing the outbound requests from the feed-delete paths (`src/routes/admin/feeds.tsx`), ideally via `ctx.waitUntil`.

## Heavy

- [x] **Email attachments as RSS enclosures** — store attachments in Cloudflare R2 and expose them as `<enclosure>` elements in the feed. kill-the-newsletter serves them at `/files/{enclosureId}/{filename}`.

- [x] **WebSub (PubSubHubbub) push notifications** — notify subscribers in real time when a new email arrives, instead of requiring them to poll the feed. Requires either integrating a public WebSub hub or implementing the hub protocol directly.

- [x] **Rate limiting via Cloudflare WAF rules** — protect `/api/inbound` and `/admin` against abuse. Configure WAF custom rules in the Cloudflare dashboard (or via Terraform): rate-limit `/api/inbound` to ~60 req/min per IP, and `/admin` to ~20 req/min per IP. No code changes required; this is pure infrastructure configuration.

- [ ] **Migrate feed metadata to Durable Objects for atomic writes** — the current KV-based metadata store has a read-modify-write race condition: two concurrent emails to the same feed can silently overwrite each other's changes. Cloudflare Durable Objects serialise access per feed and eliminate the race entirely. Requires replacing `feed:<feedId>:metadata` KV writes in `src/lib/email-processor.ts` with a Durable Object that exposes an `appendEmail()` RPC, updating `wrangler.toml` with a DO binding, and migrating existing metadata at deploy time.

## Per-feed favicon — design notes

Breakdown of the _"Per-feed favicon from the last sender's domain"_ item above. Goal: each feed shows an icon derived from its newsletter source, fetched once and cached so it never re-fetches on a normal request.

- [ ] **Resolve the sender domain** — on ingestion, extract the domain from the latest email's `from` address (already parsed in `src/lib/email-processor.ts`) and persist it on the feed (e.g. `icon_domain` in `FeedConfig` / feed metadata) so the icon tracks the most recent sender.

- [ ] **Fetch the favicon** — resolve an icon URL for the domain: try `https://<domain>/favicon.ico`, optionally parse the homepage for `<link rel="icon">`, and fall back to a third-party service (e.g. `https://icons.duckduckgo.com/ip3/<domain>.ico`). Run lazily/async (`ctx.waitUntil`) so it never blocks email processing.

- [ ] **Cache aggressively** — store the fetched bytes keyed by domain (R2 for the image bytes, or KV for small icons) with a long TTL (e.g. refresh ~weekly), and serve them through the Cloudflare Cache API. The domain is the cache key so feeds from the same sender share one fetch.

- [ ] **Serve endpoint** — add a route like `GET /icons/:domain` (or `GET /favicon/:feedId`) returning the cached bytes with the correct `Content-Type` and a long `Cache-Control`, falling back to the project favicon (see _Project favicon_ in Quick wins) when no domain icon is found.

- [ ] **Expose in outputs** — reference the icon from the RSS `<image>` and Atom `<icon>`/`<logo>` in `src/utils/feed-generator.ts`, and render it next to each feed in the admin list (`src/routes/admin/feeds.tsx`).

- [ ] **Failure handling** — missing/blocked favicons must degrade gracefully to the project favicon fallback; never let an icon fetch error surface to ingestion or feed rendering.
