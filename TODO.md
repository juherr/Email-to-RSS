# TODO

Feature gaps identified by comparing with [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter).

> **Origin tags.** Every idea carries an `_origin:_` reference so we can notify the source when it ships.
>
> - `ktn#N` → a [kill-the-newsletter issue/PR](https://github.com/leafac/kill-the-newsletter/issues) — **comment there when implemented** to close the loop with the requester.
> - A tool/spec URL → external inspiration (a competitor or standard); no individual to notify, but the rationale is traceable.
> - `internal` → our own design/code audit; no external requester.

> **Priority × size.** Each idea is tagged `Pn·Size`. Priority by user value: **P1** (high) / **P2** (medium) / **P3** (nice-to-have). Effort by implementation size: **S** (hours) / **M** (~1–2 days) / **L** (several days) / **XL** (week+). Done items keep the tag as a retrospective estimate.

## Quick wins

- [x] `P1·S` **Author field in RSS entries** — expose the `from` address as `<author>` in each RSS `<item>`. The value is already stored in KV, just not rendered in the feed XML. — _origin: [ktn#102](https://github.com/leafac/kill-the-newsletter/issues/102) (ktn CHANGELOG 2.0.6 "author to entry")_

- [x] `P1·M` **HTML view for individual entries** — serve each email as an HTML page at e.g. `/entries/:feedId/:timestamp`. Useful for reading emails outside a feed reader and for debugging. kill-the-newsletter serves these at `/feeds/{feedId}/entries/{entryId}.html` with a Content-Security-Policy header. — _origin: upstream alternate-HTML view; gives each item a valid URL ([ktn#17](https://github.com/leafac/kill-the-newsletter/issues/17), [ktn#40](https://github.com/leafac/kill-the-newsletter/issues/40))_

- [x] `P2·S` **JSON API for feed creation** — accept `Content-Type: application/json` on `POST /admin/feeds` and return `{ feedId, email, feedUrl }`. Useful for automation (e.g. Tofu/OpenTofu provisioning). — _origin: [ktn#43](https://github.com/leafac/kill-the-newsletter/issues/43) (ktn CHANGELOG 2.0.5)_

- [x] `P2·S` **Project favicon** — serve a single bundled icon at `/favicon.ico` and add a `<link rel="icon">` in the shared `Layout` so the admin UI, status page, and entry views stop 404-ing. Doubles as the default/fallback icon for the per-feed favicon feature below. — _origin: internal (404 fix); related [ktn#131](https://github.com/leafac/kill-the-newsletter/issues/131)_

## Medium effort

- [x] `P2·M` **Size-based feed trimming** — instead of a fixed 50-entry cap, drop the oldest entries when the feed exceeds a size threshold (kill-the-newsletter uses ~512 KB). More robust for HTML-heavy newsletters where one entry can dominate. — _origin: upstream size limit (ktn CHANGELOG 2.0.8); related [ktn#59](https://github.com/leafac/kill-the-newsletter/issues/59), [ktn#115](https://github.com/leafac/kill-the-newsletter/issues/115)_

- [x] `P1·M` **Atom feed format** — expose feeds as Atom (`application/atom+xml`) in addition to or instead of RSS 2.0. Atom has better native support for HTML content and author metadata. — _origin: upstream (Atom-native product) / internal parity_

- [x] `P3·M` **Authelia / external auth provider support** — allow delegating admin authentication to an external identity provider (e.g. Authelia, Authentik) via a trusted header (`Remote-User`, `X-Forwarded-User`) set by a reverse proxy. The Worker would accept the header as proof of authentication instead of checking the cookie, with a configurable secret or IP allowlist to trust only the proxy. — _origin: internal_

- [x] `P2·M` **Per-feed favicon from the last sender's domain** — give each feed an icon by fetching the favicon of the last sender's domain, so feeds are visually distinguishable in readers and the admin UI. Resolve the domain from the most recent email's `from`, fetch its favicon (e.g. `https://<domain>/favicon.ico` or a parsed `<link rel="icon">`, with a fallback service), and cache the result aggressively (KV/R2 + Cache API with a long TTL) so it isn't re-fetched on every request. Expose it via the RSS `<image>` / Atom `<icon>` and the admin feed list. — _origin: [ktn#92](https://github.com/leafac/kill-the-newsletter/issues/92) (ktn CHANGELOG 2.0.6/2.0.7)_

- [x] `P2·M` **RFC 8058 one-click unsubscribe on feed deletion** — when a feed is deleted, automatically unsubscribe from the newsletters that fed it so messages stop arriving at the now-dead address. Parse and store the `List-Unsubscribe` / `List-Unsubscribe-Post` headers ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.txt)) from incoming emails, then on deletion POST `List-Unsubscribe=One-Click` to each stored unsubscribe URL. Requires capturing the headers during ingestion (`src/lib/email-processor.ts`) and firing the outbound requests from the feed-delete paths (`src/routes/admin/feeds.tsx`), ideally via `ctx.waitUntil`. — _origin: internal ([RFC 8058](https://www.rfc-editor.org/rfc/rfc8058.txt))_

## Heavy

- [x] `P1·L` **Email attachments as RSS enclosures** — store attachments in Cloudflare R2 and expose them as `<enclosure>` elements in the feed. kill-the-newsletter serves them at `/files/{enclosureId}/{filename}`. — _origin: [ktn#66](https://github.com/leafac/kill-the-newsletter/issues/66), [ktn#86](https://github.com/leafac/kill-the-newsletter/issues/86) (ktn CHANGELOG 2.0.5)_

- [x] `P2·L` **WebSub (PubSubHubbub) push notifications** — notify subscribers in real time when a new email arrives, instead of requiring them to poll the feed. Requires either integrating a public WebSub hub or implementing the hub protocol directly. — _origin: [ktn#68](https://github.com/leafac/kill-the-newsletter/issues/68) (ktn CHANGELOG 2.0.4)_

- [x] `P2·S` **Rate limiting via Cloudflare WAF rules** — protect `/api/inbound` and `/admin` against abuse. Configure WAF custom rules in the Cloudflare dashboard (or via Terraform): rate-limit `/api/inbound` to ~60 req/min per IP, and `/admin` to ~20 req/min per IP. No code changes required; this is pure infrastructure configuration. — _origin: upstream parity (ktn CHANGELOG 2.0.3) / internal_

- [x] `P2·L` **REST API with OpenAPI description** — expose a documented, machine-consumable REST API for feed/email management (create/list/update/delete feeds, list/read/delete emails, read stats) so the service can be automated without scraping the admin UI. Implemented as a versioned `/api/v1/*` surface (Bearer-token auth with the admin password, plus the existing proxy-auth) built on `@hono/zod-openapi`; the OpenAPI 3.1 spec is served at `/api/openapi.json` with a Scalar docs page at `/api/docs`. Feed create/update/delete logic was extracted into `src/lib/feed-service.ts` so the admin UI and the REST API share a single source of truth. — _origin: [ktn#43](https://github.com/leafac/kill-the-newsletter/issues/43)_

- [ ] `P3·XL` **Migrate feed metadata to Durable Objects for atomic writes** — the current KV-based metadata store has a read-modify-write race condition: two concurrent emails to the same feed can silently overwrite each other's changes. Cloudflare Durable Objects serialise access per feed and eliminate the race entirely. Requires replacing `feed:<feedId>:metadata` KV writes in `src/lib/email-processor.ts` with a Durable Object that exposes an `appendEmail()` RPC, updating `wrangler.toml` with a DO binding, and migrating existing metadata at deploy time. — _origin: internal; same race behind [ktn#6](https://github.com/leafac/kill-the-newsletter/issues/6), [ktn#31](https://github.com/leafac/kill-the-newsletter/issues/31)_

## From upstream issues/PRs (2026-05-24 review)

Gaps found by reading every open/closed issue + PR on [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter/issues). These are requests we do **not** yet satisfy (many other recurring requests — dark mode, copy buttons, favicon, expiration, attachments, API, WebSub, sender-in-author — we already cover).

- [x] `P1·M` **Subscription confirmation handling** — _the single most recurring upstream request_ ([#5](https://github.com/leafac/kill-the-newsletter/issues/5), [#23](https://github.com/leafac/kill-the-newsletter/issues/23), [#57](https://github.com/leafac/kill-the-newsletter/issues/57), [#73](https://github.com/leafac/kill-the-newsletter/issues/73), [#89](https://github.com/leafac/kill-the-newsletter/issues/89), [#95](https://github.com/leafac/kill-the-newsletter/issues/95), [#97](https://github.com/leafac/kill-the-newsletter/issues/97)). Newsletters require a "click to confirm your email" step; users can't easily find/click the link buried in a feed reader. Our admin already lists emails, but nothing **surfaces** the confirmation link or shows the first email inline right after feed creation. Low effort, high payoff (admin UX in `src/routes/admin/feeds.tsx` + maybe extract candidate confirm links during ingestion in `src/application/email-processor.ts`). — **Shipped:** v1 detects confirmation emails at ingestion (multilingual keyword + link scoring) and surfaces the link in the admin (detail section, list badge, dashboard pill, emails-page banner + dismiss); post-create now lands on the feed's emails page. v1 does no outbound request; server on-detect actions deferred (see below).

- [ ] `P2·M` **Confirmation on-detect server action (none / autoclick / forward)** — extend the shipped confirmation detection with a server-configured action via an env var (default `none`): `autoclick` = follow the detected confirm link server-side from the worker (⚠ guard SSRF: http(s) only, block internal/private IP ranges, timeout, no redirect to non-http schemes); `forward` = forward the original email to `FALLBACK_FORWARD_ADDRESS`. Touches `src/application/email-processor.ts`, `Env` (`src/types/index.ts`), `src/infrastructure/cloudflare-email.ts`. — _origin: internal (juherr)_

- [x] `P1·M` **Separate write (email) / read (feed) IDs** — _most-requested privacy gap, still open upstream_ ([#114](https://github.com/leafac/kill-the-newsletter/issues/114), [#93](https://github.com/leafac/kill-the-newsletter/issues/93), [#75](https://github.com/leafac/kill-the-newsletter/issues/75)). The two identities are now decoupled: `FeedId` is an **opaque random token** (`FeedId.generate()` → 22-char base64url) used as the KV storage key and the public read id (`/rss/:feedId`), while the inbound address is a separate `MailboxId` VO (`noun.noun.NN`, the old format) resolved to its feed **only at reception** via a new `inbound:<mailboxId>` secondary index (`src/infrastructure/feed-repository.ts` `resolveInbound`). `MailboxId.parse` owns the untrusted-input boundary (moved off `FeedId`); the mailbox lives on `FeedState.mailboxId` / `mailbox_id` and is projected into `feeds:list`. Reading `/rss/<noun.noun.NN>` 404s and no public feed output contains the inbound address. Pre-release, so no migration/backward-compat. — _origin: [ktn#114](https://github.com/leafac/kill-the-newsletter/issues/114), [ktn#93](https://github.com/leafac/kill-the-newsletter/issues/93), [ktn#75](https://github.com/leafac/kill-the-newsletter/issues/75)_

- [ ] `P2·S` **Rotate the inbound mailbox and/or feed id** — _follow-up to the write/read separation above_. Now that the inbound address (`MailboxId`) and the read id (`FeedId`) are decoupled, offer an admin + REST action to **re-mint** either one to revoke a leaked subscribe address or a shared feed URL. Rotating the mailbox: generate a new `MailboxId`, write the new `inbound:<new>` index, delete the old; rotating the read id is heavier (it's the KV storage key — would require re-keying `feed:<id>:*`, so prefer rotating only the mailbox first). Touch `feed-service.ts`, `feed-repository.ts`, admin UI, `api/index.ts`. — _origin: internal (privacy)_

- [ ] `P2·M` **Proxy/prefetch remote images** ([#69](https://github.com/leafac/kill-the-newsletter/issues/69)). We already proxy inline `cid:` images via R2, but remote `<img src="https://…">` stay remote → tracking pixels fire on read. Extend `src/infrastructure/html-processor.ts` to rewrite remote image src through a worker proxy/cache endpoint (reuse the R2 + Cache API pattern from favicons).

- [ ] `P3·M` **Tracking-link redirect resolver** ([#36](https://github.com/leafac/kill-the-newsletter/issues/36)). Unwrap marketing/tracking URLs (e.g. `click.convertkit-mail…`) to their final destination so the redirect/tracking happens server-side (or is stripped) instead of from the reader. Lives in `src/infrastructure/html-processor.ts`. Mind SSRF/abuse surface when following redirects.

- [ ] `P2·S` **Strip-styles / plaintext rendering option** ([#74](https://github.com/leafac/kill-the-newsletter/issues/74), [#119](https://github.com/leafac/kill-the-newsletter/issues/119)). Some readers render newsletter HTML/CSS poorly. Offer an opt-in to strip `<style>` + inline styles (keeping links), or to prefer the `text/plain` part. Per-feed setting + `src/infrastructure/html-processor.ts`.

- [ ] `P2·S` **Optional sender in entry title** ([#123 — open PR upstream](https://github.com/leafac/kill-the-newsletter/pull/123), [#124](https://github.com/leafac/kill-the-newsletter/issues/124)). We already emit `<author>`, but some users want `[Sender] Subject` as the entry title for at-a-glance scanning in the reader. Per-feed toggle + `src/infrastructure/feed-generator.ts`.

- [ ] `P2·S` **Detect a newsletter's native Atom/RSS feed** — _top item on upstream's own [TODO](https://github.com/leafac/kill-the-newsletter/blob/main/TODO.md), not yet built there_. When an incoming email's HTML contains `<link rel="alternate" type="application/atom+xml">` (or `application/rss+xml`), surface it: "this newsletter already publishes a feed — subscribe to it directly instead." We already parse HTML with linkedom in `src/infrastructure/html-processor.ts`, so detection is cheap; store the discovered URL on the feed and show it in the admin UI / a feed entry. A genuine differentiator — we'd ship it before upstream.

- [x] `P1·S` **`X-Robots-Tag: none` on feed + entry routes** ([#33](https://github.com/leafac/kill-the-newsletter/issues/33)). Private feeds/emails should never be search-indexed. Upstream sets `X-Robots-Tag: none` on its responses; we set a CSP on `/entries` but **no** robots header anywhere. Add `X-Robots-Tag: noindex` to `rss.ts`, `atom.ts`, `entries.ts`, `files.ts` (and optionally a `/robots.txt`). Low effort, real privacy gap.

## From similar projects & RSS readers (2026-05-24 review)

Ideas from competitors (Feedbin, Readwise Reader, Inoreader, Omnivore, LetterFeed, Mailbrew, mail2rss) and from what leading readers (NetNewsWire, Reeder, Feedly, Inoreader, NewsBlur, Miniflux, FreshRSS) can consume. Deduplicated against the upstream-issues section above. Tagged **[table-stakes]** vs **[differentiating]**.

### Feed-output enrichments (small XML wins — we use the `feed` lib, which already emits `content:encoded`, `atom:link rel="self"`, stable `<guid>`)

- [x] `P2·S` **JSON Feed endpoint** `GET /json/:feedId` **[differentiating, cheap]** — the `feed` lib's `.json1()` (emits JSON Feed v1) wired via `generateJsonFeed` in `src/infrastructure/feed-generator.ts`, served at `/json/:feedId` (`src/routes/json.ts`) with `Content-Type: application/feed+json` + WebSub hub `Link`. All three formats cross-link via `feedLinks`. Natively consumed by NetNewsWire, Reeder, NewsBlur, Feedly. — _origin: [JSON Feed 1.1 spec](https://www.jsonfeed.org/version/1.1/) (reader ecosystem)_

- [ ] `P3·S` **Upgrade JSON Feed output to v1.1** **[correctness, niche]** — our `/json/:feedId` emits `version: "https://jsonfeed.org/version/1"` because the `feed` lib's `.json1()` only implements v1, and the upstream request to bump it was **closed as _not planned_** ([jpmonette/feed#139](https://github.com/jpmonette/feed/issues/139)). So a true v1.1 feed needs a small post-process pass on the `.json1()` object in `generateJsonFeed` (`src/infrastructure/feed-generator.ts`): set `version` to `https://jsonfeed.org/version/1.1`, and apply the [v1.1 changes](https://www.jsonfeed.org/version/1.1/#changes-a-name-changes-a) — promote the deprecated top-level/item `author` to `authors` (array), and add the top-level `language` field. Low value (every reader still parses v1) but cheap and removes a spec-compliance footnote. — _origin: [jpmonette/feed#139 (closed, not planned)](https://github.com/jpmonette/feed/issues/139); [JSON Feed 1.1 spec](https://www.jsonfeed.org/version/1.1/)_

- [ ] `P2·M` **Per-item `<category>` + per-feed tags/categories** **[differentiating]** — we set no categories today. Tag entries by sender (or a user-set feed category) so readers (Inoreader, Feedly, NewsBlur) can filter/mute subsets. Pairs with the filtering item below; touches `FeedState`, `feed-generator.ts`. — _origin: [RSS best practices (kevincox)](https://kevincox.ca/2022/05/06/rss-feed-best-practices/); Inoreader/Feedly filtering_

- [ ] `P3·S` **Reader cadence hints: `<ttl>` + `sy:updatePeriod`/`sy:updateFrequency`** **[table-stakes, niche]** — advertise the feed's real update rhythm so pollers (FreshRSS, Miniflux, Inoreader) back off; complements our WebSub push. Support is uneven, so keep it as a hint alongside WebSub. Also advertise the WebSub hub link _inside_ the XML (`<atom:link rel="hub">`), not only the HTTP `Link` header. — _origin: [FreshRSS TTL #6721](https://github.com/FreshRSS/FreshRSS/issues/6721)_

- [ ] `P2·M` **Media RSS lead image (`<media:content>`/`<media:thumbnail>`)** **[differentiating]** — extract the first image of each email as a thumbnail so card/story layouts (Feedly, Inoreader, NewsBlur) show a preview. The `feed` lib doesn't emit Media RSS, so this needs post-processing or a custom serializer. — _origin: [Media RSS spec](https://www.rssboard.org/media-rss); Feedly/Inoreader consume it_

### Ingestion & processing

- [ ] `P2·M` **Keyword/subject filtering rules (keep/drop)** **[differentiating]** — we already have _sender_ allow/block (`SenderPolicy`), but no content rules. Add per-feed keep/drop rules by subject or body keyword (Inoreader/Omnivore-style), applied in `src/application/email-processor.ts` at the same gate as the sender policy. — _origin: [Inoreader rules](https://www.inoreader.com/blog/2020/02/declutter-your-inbox-subscribe-to-email-newsletters-straight-into-inoreader.html); Omnivore filters_

- [ ] `P2·M` **Confirmation-code relay** **[differentiating]** — _extends the "Subscription confirmation handling" item above_. Readwise Reader auto-detects "reply with code X" / "click to confirm" emails and surfaces (or relays) the code. Beyond just showing the link: detect the confirm pattern and present a one-tap action in admin. — _origin: [Readwise Reader docs](https://docs.readwise.io/reader/docs/faqs/email-newsletters); also [ktn#89](https://github.com/leafac/kill-the-newsletter/issues/89) (reply-to-confirm)_

- [ ] `P3·XL` **IMAP-pull ingestion option** **[differentiating for self-hosters]** — alternative to the ForwardEmail/Cloudflare-Email webhook: poll an existing IMAP mailbox and route allow-listed senders to feeds (LetterFeed model). Big lift on a Worker (needs a scheduled fetch + IMAP over a TCP socket / external relay); evaluate feasibility before committing. — _origin: [LetterFeed](https://github.com/LeonMusCoden/LetterFeed); also [ktn#26](https://github.com/leafac/kill-the-newsletter/issues/26) (use IMAP instead of hosting a mail server)_

### Reading experience

- [x] `P2·S` **OPML export** `GET /admin/opml` **[table-stakes, easy]** — export all feeds as an OPML 2.0 outline (`<outline type="rss" xmlUrl=…>` per feed, XML-attr-escaped) so users can bulk-import every feed into their reader in one shot. Mounted on the admin Hono app (inherits the admin auth middleware) rather than public, because the registry lists every feed's RSS URL — a public endpoint would leak them all. Returns `Content-Disposition: attachment; filename="feeds.opml"`. Implemented in `src/routes/opml.ts` over `FeedRepository.listFeeds()`. — _origin: reader ecosystem ([NetNewsWire](https://github.com/Ranchero-Software/NetNewsWire/)); Feedbin OPML export_

- [ ] `P2·L` **Full-text search across received emails** **[differentiating]** — admin-side search over subjects + bodies (Omnivore/Feedbin have this). On KV this means an index or scan; consider scope (subject-only first) before building. — _origin: [Omnivore](https://www.timeatlas.com/omnivore-newsletters/); Feedbin search_

- [ ] `P3·L` **Readability / clean-text view toggle** **[differentiating]** — _related to "strip-styles" above but distinct_: run a readability extraction (article body only) as an opt-in per feed, remembered per sender (Readwise pattern), rather than just stripping CSS. — _origin: [Readwise Reader feed docs](https://docs.readwise.io/reader/docs/faqs/feed)_

### Greenfield differentiators

- [ ] `P2·L` **AI per-newsletter summarization** **[differentiating]** — generate a short TL;DR per email (or a daily digest summary) using Cloudflare Workers AI (no new vendor, no key to manage). Almost no competitor ships this well. Add an `AI` binding + an opt-in per-feed flag; render the summary atop the entry content. — _origin: [Precis](https://github.com/leozqin/precis), [babarot AI reader](https://dev.to/babarot/i-built-a-self-hosted-rss-reader-with-ai-summarization-translation-and-an-mcp-server-316c)_

- [ ] `P3·L` **Digest / bundling mode** **[differentiating]** — for low-volume feeds, batch N emails into a single periodic digest entry (Mailbrew model) so readers aren't flooded. Per-feed cadence setting; runs on the existing cron. — _origin: [Mailbrew](https://www.readless.app/blog/mailbrew-pricing-2026)_

## Robustness, delivery, auth & integrations (2026-05-24 deep dig)

Verified-missing in our code, deduplicated against the sections above. From a code audit + a sweep of niche/recent tools (Precis, changedetection.io+Apprise, MailCast email-to-podcast, FreshRSS/Miniflux token auth, RFC 5005, postly dedup).

### Delivery / bandwidth

- [x] `P2·S` **Conditional GET on feeds (ETag + Last-Modified + 304)** **[table-stakes, easy]** — `rss.ts`/`atom.ts` now emit a strong `ETag` (`"<format>-<feedId>-<count>-<maxReceivedAt>"`) and `Last-Modified` (newest `receivedAt`), and return `304 Not Modified` on matching `If-None-Match`/`If-Modified-Since` before generating any XML. Validators are computed from the loaded `FeedData` (not the rendered bytes) in `src/infrastructure/http-cache.ts` (`computeFeedValidators`/`isNotModified`/`notModifiedResponse`), shared by both routes; rss vs atom get distinct ETags via the format prefix. Cuts bandwidth for every polling reader. — _origin: internal code audit ([RFC 9110 conditional requests](https://www.rfc-editor.org/rfc/rfc9110#name-conditional-requests))_

- [ ] `P3·L` **RFC 5005 paged / archived feeds** **[differentiating, niche]** — readers only ever see the capped current window; older entries vanish. Mark the subscription document `fh:complete` and expose `prev-archive` pages so readers can backfill history. Pairs naturally with our expiring-feed model (an expired feed = a sealed archive). ([RFC 5005](https://www.rfc-editor.org/rfc/rfc5005.html))

### Ingestion robustness

- [x] `P1·M` **Duplicate-send dedup** **[differentiating]** — a newsletter resent (or delivered twice) is now stored once. `storeEmail` (`src/application/email-processor.ts`) computes the `Message-ID` (case-insensitive header lookup) and a SHA-256 of normalized `subject+content`, then asks the aggregate `feed.hasDuplicate(messageId, dedupHash)` (`src/domain/feed.aggregate.ts`): primary match on `Message-ID`, fallback to the content hash when neither side has a Message-ID. A duplicate is a successful no-op (`{ ok: true }`, nothing stored/dispatched) and bumps a new `emails_deduplicated` counter (status page + `/api/v1/stats`). `EmailMetadata` gained additive `messageId?`/`dedupHash?` fields, so pre-feature entries never false-match. Fixes the upstream "duplicate posts" complaint ([#31](https://github.com/leafac/kill-the-newsletter/issues/31), [#6](https://github.com/leafac/kill-the-newsletter/issues/6)).

- [ ] `P3·M` **Calendar (.ics) invite extraction** **[differentiating, novel]** — no email→feed tool does this. Detect `text/calendar` parts, parse the event, and surface it in the entry (summary + an `.ics` enclosure / add-to-calendar link). Useful for event/booking newsletters. — _origin: internal (novel; no external requester)_

- [x] `P2·S` **`FALLBACK_FORWARD_ADDRESS` — catch-all fallback forwarding** **[differentiating for self-hosters]** — today `handleCloudflareEmail` silently drops (just `logger.warn`) any address that isn't a feed, so you can't point a domain's _catch-all_ at KTN without swallowing your personal mail. Add an optional `FALLBACK_FORWARD_ADDRESS` env var: after `processEmail`, forward non-feed mail to it based on `result.reason` — **forward** on `invalid_address` (not a `noun.noun.NN` address) and `feed_not_found` (well-formed but no such feed); **drop** on `feed_expired` and `sender_blocked` (don't leak a newsletter to the fallback box); nothing on `ok`. Unset env → current drop+log behavior unchanged. The destination must be a _verified_ Cloudflare Email Routing address or `message.forward()` fails; `await` it in a `try/catch` (`logger.warn` on failure), forward at most once. Touch: `Env` (`src/types/index.ts`), `src/infrastructure/cloudflare-email.ts` (`result.reason` already available), `cloudflare-email.test.ts` (forwarded for `feed_not_found`/`invalid_address` when set; not for `feed_expired`/`sender_blocked`; not when unset), `wrangler-example.toml` (commented `# FALLBACK_FORWARD_ADDRESS` under `[vars]`), `INSTALL.md` ("Catch-all fallback forwarding" section: verified-destination prerequisite + use case). — _origin: internal (juherr — self-host on juherr.dev catch-all); generic "use KTN as my domain's catch-all"_

### Auth & privacy

- [ ] `P2·M` **Scoped / multiple API tokens (admin-managed)** **[security]** — the REST API currently accepts the single `ADMIN_PASSWORD` as the bearer (`src/infrastructure/auth.ts`). Add named, independently-revocable tokens (optionally read-only or feed-scoped) that the admin can **create, list, and revoke from the admin UI** (stored hashed in KV, shown once on creation), so automation doesn't hold the master password. The bearer middleware then accepts either `ADMIN_PASSWORD` or any active token; revoking a token is instant. — _origin: internal security audit; juherr (manage API tokens)_

- [ ] `P2·S` **Change the admin password from the UI** **[security]** — today `ADMIN_PASSWORD` is a Worker secret set via `wrangler secret put`, so rotating it means a redeploy. Add an admin-UI action (current password + new password) that stores a hashed password override in KV (e.g. `admin:password`); `src/infrastructure/auth.ts` checks the KV override first and falls back to the `ADMIN_PASSWORD` env secret when unset, so existing installs keep working and the env var becomes the bootstrap/reset default. Pairs with the API-tokens item (same auth surface). — _origin: internal; juherr (change admin password)_

- [ ] `P3·XL` **Multi-user support** **[differentiating]** — today the app is single-admin (one `ADMIN_PASSWORD` guards all feeds; `feeds:list` is global). Support multiple user accounts, each owning a private subset of feeds: per-user credentials/sessions, feed ownership on `FeedState`, per-user feed registry (scope `feeds:list` by owner), and admin scoping across the admin UI + REST API. Big lift — touches auth, the feed registry/key schema, and every admin/API route; depends on the change-password and API-token items as the auth foundation. ⚠ Note the off-Cloudflare epic currently lists "Multi-tenant / multi-domain admin" as out of scope — reconcile that scope boundary before committing. — _origin: internal; juherr (multi-user)_

- [ ] `P2·M` **Token-protected private feeds** **[security, differentiating]** — `/rss` and `/atom` are public-by-obscurity (anyone with the URL reads it). Offer an opt-in `?token=…` (FreshRSS-style) or HMAC-signed, optionally expiring URL (fits our expiring-feed model) so a feed can be truly private and shareable without leaking the inbound address. Complements the _separate write/read IDs_ item above. ([FreshRSS](https://freshrss.github.io/FreshRSS/en/admins/09_AccessControl.html))

### Push & integrations

- [ ] `P2·L` **Push new items to chat (per-feed)** **[differentiating]** — for users who don't run a reader, push each new email to Telegram / Discord / ntfy / a generic webhook, routed per feed, instant-vs-digest toggle (Precis / changedetection.io+Apprise pattern). Fires from the existing event dispatcher (`src/application/feed-events.ts`) via `ctx.waitUntil`. ([Precis](https://github.com/leozqin/precis))

### Novel / stretch (Cloudflare-native)

- [ ] `P3·M` **MCP server over your feeds** **[differentiating, novel]** — expose feeds/emails to AI agents via a Model Context Protocol endpoint on the Worker, so an assistant can read/search a user's newsletters. Cheap to add on a Worker, genuinely new in this space. — _origin: [babarot AI reader + MCP](https://dev.to/babarot/i-built-a-self-hosted-rss-reader-with-ai-summarization-translation-and-an-mcp-server-316c)_

- [ ] `P3·L` **Email-to-podcast (TTS audio enclosure)** **[differentiating, novel]** — opt-in: synthesize each newsletter to audio (Cloudflare Workers AI TTS), store in R2, attach as an `<enclosure>` so the feed doubles as a private podcast. Reframes feed item = audio. ([prior art](https://github.com/tcanfarotta/email-to-podcast-rss))

> Framing notes (no code, worth surfacing in docs/landing): we already deliver several things competitors charge for — **full-body capture bypasses Substack/"read more" truncation** (we ingest the email, not the scraped page), and each feed's inbound address is effectively a **burnable alias** (delete the feed + RFC 8058 one-click unsubscribe already kills the sender). Market these explicitly.

## Feed namespaces & reader-rendering correctness (2026-05-24 deep dig)

Two final angles: (1) less-common RSS/Atom namespaces that visibly improve feeds in real readers, and (2) generator-side correctness fixes that stop feeds breaking in self-hosted readers. The `feed` lib emits `content:encoded`/`atom:link rel=self`/stable `<guid>` but does **not** handle the items below — they need its custom-namespace/extension hooks or a post-process pass.

### Namespaces worth emitting

- [ ] `P2·S` **WebFeeds branding (`webfeeds:accentColor`, `webfeeds:icon`, `webfeeds:logo`, `webfeeds:cover`)** **[differentiating, high visible payoff]** — Feedly puts your SVG logo on every story and recolors links to your accent color. We already derive a per-feed favicon; add an accent + logo for branded-looking feeds. — _origin: [Working With Web Feeds (CSS-Tricks)](https://css-tricks.com/working-with-web-feeds-its-more-than-rss/)_

- [ ] `P2·M` **Media RSS thumbnail/credit (`media:thumbnail`, `media:description`, `media:credit`)** **[differentiating]** — richer than the lead-image item above: gives readers a card image, alt text, and attribution. — _origin: [Media RSS spec](https://www.rssboard.org/media-rss)_

- [ ] `P3·S` **Dublin Core `dc:creator`** **[niche, cheap]** — credits the newsletter sender **without** an email address (RSS `<author>` requires one); safer than a synthetic `noreply@`. — _origin: [RSS Best Practices Profile](https://www.rssboard.org/rss-profile), [mod_dublincore](https://www.oreilly.com/library/view/developing-feeds-with/0596008813/re08.html)_

- [ ] `P3·M` **Podcast namespace (`itunes:*` + `podcast:transcript`/`chapters`)** **[stretch]** — only if the email-to-podcast item ships; turns the audio feed into a real Podcasting 2.0 feed. — _origin: [Podcast Namespace](https://podcasting2.org/docs/podcast-namespace)_

### Reader-rendering correctness (turn these into hardening tasks)

- [x] `P1·S` **Rewrite relative URLs in content to absolute** **[correctness]** — most readers ignore `xml:base`; relative `src`/`href` in `content:encoded` break in Miniflux/NetNewsWire. Absolutize every link/image before emitting (`src/infrastructure/html-processor.ts`). — _origin: [W3C ContainsRelRef](https://validator.w3.org/feed/docs/warning/ContainsRelRef.html)_

- [x] `P1·S` **Promote lazy-loaded images (`data-src` → `src`, strip `loading="lazy"`)** **[correctness]** — newsletters with lazy images render blank in readers. — _origin: [Hugo RSS & lazy images](https://brainbaking.com/post/2021/01/hugo-rss-feeds-and-lazy-image-loading/)_

- [x] `P1·S` **Strip XML-illegal control chars + guarantee valid UTF-8** **[correctness]** — a single bad codepoint fails the _whole_ feed parse in strict readers (newsboat). Sanitize before serialization. — _origin: [newsboat #2328](https://github.com/newsboat/newsboat/issues/2328), [W3C SAXError](https://validator.w3.org/feed/docs/error/SAXError.html); upstream hit this too ([ktn#1](https://github.com/leafac/kill-the-newsletter/issues/1) cyrillic, [ktn#9](https://github.com/leafac/kill-the-newsletter/issues/9) invalid XML char)_

- [ ] `P2·S` **Real `enclosure` byte length + correct type (never `length="0"`)** **[correctness]** — zero/missing length makes podcast clients reject the enclosure; use the actual R2 object size. — _origin: [AzuraCast #7809](https://github.com/AzuraCast/AzuraCast/issues/7809)_

- [x] `P1·S` **Plain-text `<title>` (strip HTML, decode entities)** **[correctness]** — raw tags in titles show literally in readers; keep markup only in `content`. — _origin: [RSS.app feed output guide](https://help.rss.app/en/articles/10769849-guide-to-feed-output); upstream [ktn#11](https://github.com/leafac/kill-the-newsletter/issues/11) (subject placed as link)_

## Per-feed favicon — design notes

Breakdown of the _"Per-feed favicon from the last sender's domain"_ item above (the parent is `P2·M`; these sub-tasks are each ~`S`). Goal: each feed shows an icon derived from its newsletter source, fetched once and cached so it never re-fetches on a normal request.

- [x] `P2·S` **Resolve the sender domain** — on ingestion, extract the domain from the latest email's `from` address (`extractEmailDomain` in `src/utils/favicon-fetcher.ts`) and persist it as `iconDomain` on the feed metadata so the icon tracks the most recent sender.

- [x] `P2·S` **Fetch the favicon** — resolve an icon URL for the domain: try `https://<domain>/favicon.ico`, then fall back to `https://icons.duckduckgo.com/ip3/<domain>.ico`. Runs async via `ctx.waitUntil` so it never blocks email processing.

- [x] `P2·S` **Cache aggressively** — store the fetched bytes (base64) keyed by domain in KV with a 1-week TTL (`ICON_TTL_SECONDS`). The domain is the cache key so feeds from the same sender share one fetch; the fetch only fires when the cache entry is absent/expired.

- [x] `P2·S` **Serve endpoint** — `GET /favicon/:feedId` returns the cached bytes with the correct `Content-Type` and a long `Cache-Control`, falling back to the project favicon when no domain icon is found.

- [x] `P2·S` **Expose in outputs** — the icon is referenced from the RSS `<image>` and Atom `<icon>`/`<logo>` in `src/utils/feed-generator.ts`, and rendered next to each feed in the admin list/table (`src/routes/admin.tsx`).

- [x] `P2·S` **Failure handling** — missing/blocked favicons degrade gracefully to the project favicon fallback (negative cache entry); icon fetch errors never surface to ingestion or feed rendering.

## Operability, versioning & ecosystem (2026-05-24)

Self-host operational quality-of-life: knowing which version you run, when to update, and how many people run KTN.

- [ ] `P3·S` **Display the running version** **[table-stakes, easy]** — surface the deployed app version (from `package.json` `version`, currently `0.2.1`) somewhere visible: the admin UI footer and/or the public status page (`src/routes/home.tsx`), and ideally the `/health` JSON. Bundle the version at build time (inline the `package.json` version into the Worker, since there's no filesystem at runtime) and render it. Foundation for the update-notification item below. — _origin: internal_

- [ ] `P3·M` **Notify when an update is available** **[differentiating for self-hosters]** — compare the running version against the latest GitHub Release tag and show a discreet "update available → vX.Y.Z" banner in the admin UI when behind. Fetch `https://api.github.com/repos/<owner>/<repo>/releases/latest` (cache aggressively — Cache API / KV with a long TTL — to respect GitHub rate limits and avoid a call per page load), compare semver against the bundled version. Depends on the "display version" item. Keep it opt-out-able (it makes one outbound call). — _origin: internal_

- [ ] `P3·L` **Public instances directory and/or instance counter (opt-in telemetry)** **[differentiating, ecosystem]** — let a self-hosted instance optionally announce itself to a central registry so we can show a count of live instances (and, if the operator opts in to being listed, a public directory of instances). Each instance periodically pings a central endpoint (on the existing cron) with minimal, **opt-in** data (e.g. an anonymous instance id + version; a public listing would additionally need a name/URL the operator explicitly provides). ⚠ Privacy-first: **off by default**, clearly documented, no PII/feed data ever sent; respect "count me but don't list me". Needs a central collector (a separate tiny Worker + KV/DO) plus an `INSTANCE_TELEMETRY`/`INSTANCE_DIRECTORY` opt-in env on the client side, fired from `index.ts`'s `scheduled` handler. — _origin: internal_

## Epic: Pluggable runtime, storage & ingestion (off-Cloudflare support)

`P2·XL` **Run KTN off Cloudflare from one codebase, adapter-selected by config.** Reference non-CF target: **Clever Cloud** (container + Cellar S3 + a KV/SQL add-on) with **Sweego** inbound for email. — _origin: internal (broader audience / reduced lock-in)_

**Context / motivation.** KTN is Cloudflare-native: Workers runtime, KV + R2 bindings, Email Workers, cron triggers. The v0.2.0 DDD refactor already introduced the seams that make portability tractable — KV access is behind repository adapters (`FeedRepository`, `IconRepository`, `WebSubSubscriptionRepository`, `CountersRepository`), ingestion is transport-agnostic (`processEmail` is decoupled from the CF email handler, and a webhook path `/api/inbound` already exists), HTTP is Hono (runtime-agnostic), and background work is abstracted behind `BackgroundScheduler`. This epic turns those seams into selectable adapters so KTN can run on a plain Node/container host with non-CF storage and email ingestion.

**Goal / outcome.** KTN runs on two reference profiles from one codebase:

- **A — CF-native (today):** Workers + KV + R2 + Cloudflare Email Routing.
- **B — Clever+Sweego:** Node container + Cellar (S3 blob) + KV-store add-on + Sweego inbound webhook + Node scheduler.

Adapter chosen by config (env), no code change. Same test suite green on both.

**Coupling points → adapters.**

| Area               | CF-native (today)                                      | New adapter (target B)                                         |
| ------------------ | ------------------------------------------------------ | -------------------------------------------------------------- |
| Runtime/entrypoint | `export default { fetch, email, scheduled }`           | Node entrypoint (`@hono/node-server`) + Dockerfile             |
| HTTP               | Hono (portable)                                        | Hono (no change; abstract CF-only globals)                     |
| KV store           | `KVNamespace` binding                                  | SQL (Postgres/SQLite) or Redis (Materia KV) adapter            |
| Blob/attachments   | `R2Bucket` binding                                     | S3-compatible (Cellar) via aws4fetch/S3 client                 |
| Email ingestion    | CF Email Worker (`ForwardableEmailMessage`)            | Sweego inbound webhook → `/api/inbound`                        |
| Cron cleanup       | CF cron trigger                                        | Node scheduler (node-cron) or external trigger                 |
| Background         | `ctx.waitUntil` (already behind `BackgroundScheduler`) | run-and-await Node impl                                        |
| Config/DI          | CF bindings on `Env`                                   | driver-selection layer (`*_DRIVER` envs) wiring repos→backends |

**Sub-tasks (deliverable independently).**

- [ ] `P2·M` **Storage driver abstraction + config layer** — formalize the repository interfaces already implied by `FeedRepository` et al.; add a DI/config layer selecting backends from env. Foundation; no behavior change on CF. — _origin: internal_
- [ ] `P2·M` **Blob adapter: S3-compatible (Cellar)** — put attachments behind a `BlobStore` interface; CF R2 + S3 (aws4fetch, works on Workers and Node). Lowest risk, immediately reusable. — _origin: internal_
- [ ] `P2·L` **KV-store adapter for self-host** — implement the key schema over SQL (recommended: Postgres/SQLite for list-by-prefix semantics) and/or Redis. ⚠ If targeting Materia KV, confirm KTN never relies on `RENAME` (Materia lacks it — see consumer's ADR-0011); audit the single key schema. — _origin: internal_
- [ ] `P2·L` **Node runtime entrypoint + container** — `@hono/node-server`, Dockerfile, health endpoint; abstract CF-only globals (`caches`, reliance on `CF-Connecting-IP` in proxy-auth → generalize to `X-Forwarded-For`/trusted-proxy config). — _origin: internal_
- [ ] `P2·L` **Ingestion transport abstraction + Sweego adapter** — generalize `/api/inbound` to provider-agnostic: pluggable payload parser (Sweego JSON → `ProcessEmailInput`, mirroring `parseForwardEmailPayload`) + pluggable webhook auth (HMAC signature / shared secret / IP allowlist). Document that `message.forward()` fallback is CF-Email-Worker-only; on webhook transports, unmatched-mail handling is the provider's concern (Sweego catch-all is isolated to the inbound domain, so the fallback hack isn't needed). — _origin: internal_
- [ ] `P2·M` **Scheduler adapter** — make `feed-cleanup` runnable via a Node scheduler or an authenticated `/internal/cron` endpoint for external triggers. — _origin: internal_
- [ ] `P2·M` **CI matrix + docs** — build/test both targets; INSTALL.md Clever+Sweego profile; deployment guide. — _origin: internal_

**Open questions (resolve before the Sweego adapter sub-task).**

- Sweego inbound: webhook auth mechanism (HMAC? signed header? IP list?), JSON payload schema, and attachment delivery (inline base64 vs URLs vs multipart) — drives the parser + how attachments stream into the blob store.
- Clever KV backend choice: Materia KV (Redis, no `RENAME`) vs Postgres add-on — decide from the key-op audit in the KV-store sub-task.

**Out of scope.**

- Running KTN's own SMTP/MTA server (inbound stays delegated: CF Email Routing, Sweego, or ForwardEmail). No port-25 listener.
- Multi-tenant / multi-domain admin.

**Acceptance criteria.**

- One codebase deploys to both profiles via config only.
- Full vitest suite green on both runtimes.
- Documented end-to-end Clever+Sweego deploy: a newsletter to `noun.noun.NN@<inbound-domain>` lands in a feed; attachments served from Cellar; cleanup cron runs.
- No regression on the CF-native profile.
