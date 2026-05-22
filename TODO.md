# TODO

Feature gaps identified by comparing with [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter).

## Quick wins

- [x] **Author field in RSS entries** — expose the `from` address as `<author>` in each RSS `<item>`. The value is already stored in KV, just not rendered in the feed XML.

- [x] **HTML view for individual entries** — serve each email as an HTML page at e.g. `/entries/:feedId/:timestamp`. Useful for reading emails outside a feed reader and for debugging. kill-the-newsletter serves these at `/feeds/{feedId}/entries/{entryId}.html` with a Content-Security-Policy header.

- [x] **JSON API for feed creation** — accept `Content-Type: application/json` on `POST /admin/feeds` and return `{ feedId, email, feedUrl }`. Useful for automation (e.g. Tofu/OpenTofu provisioning).

## Medium effort

- [x] **Size-based feed trimming** — instead of a fixed 50-entry cap, drop the oldest entries when the feed exceeds a size threshold (kill-the-newsletter uses ~512 KB). More robust for HTML-heavy newsletters where one entry can dominate.

- [x] **Atom feed format** — expose feeds as Atom (`application/atom+xml`) in addition to or instead of RSS 2.0. Atom has better native support for HTML content and author metadata.

- [x] **Authelia / external auth provider support** — allow delegating admin authentication to an external identity provider (e.g. Authelia, Authentik) via a trusted header (`Remote-User`, `X-Forwarded-User`) set by a reverse proxy. The Worker would accept the header as proof of authentication instead of checking the cookie, with a configurable secret or IP allowlist to trust only the proxy.

## Heavy

- [x] **Email attachments as RSS enclosures** — store attachments in Cloudflare R2 and expose them as `<enclosure>` elements in the feed. kill-the-newsletter serves them at `/files/{enclosureId}/{filename}`.

- [x] **WebSub (PubSubHubbub) push notifications** — notify subscribers in real time when a new email arrives, instead of requiring them to poll the feed. Requires either integrating a public WebSub hub or implementing the hub protocol directly.

- [ ] **Rate limiting via Cloudflare WAF rules** — protect `/api/inbound` and `/admin` against abuse. Configure WAF custom rules in the Cloudflare dashboard (or via Terraform): rate-limit `/api/inbound` to ~60 req/min per IP, and `/admin` to ~20 req/min per IP. No code changes required; this is pure infrastructure configuration.

- [ ] **Migrate feed metadata to Durable Objects for atomic writes** — the current KV-based metadata store has a read-modify-write race condition: two concurrent emails to the same feed can silently overwrite each other's changes. Cloudflare Durable Objects serialise access per feed and eliminate the race entirely. Requires replacing `feed:<feedId>:metadata` KV writes in `src/lib/email-processor.ts` with a Durable Object that exposes an `appendEmail()` RPC, updating `wrangler.toml` with a DO binding, and migrating existing metadata at deploy time.
