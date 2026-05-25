# CLAUDE.md

This file provides guidance to Claude Code when working in this repository.

## Commands

```bash
npm install           # Install dependencies (also builds client scripts via prepare)
npm run dev           # Start local dev server (wrangler dev)
npm test              # Run all tests once
npm run test:watch    # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run build         # Dry-run deploy bundle (wrangler deploy --dry-run)
npm run build:client  # Compile client scripts only (src/scripts/client → src/scripts/generated)
npm run deploy        # Deploy to Cloudflare production
npm run format        # Format with Prettier
```

Run a single test file:

```bash
npx vitest run src/routes/admin.test.ts
```

## Project summary

kill-the-news is a Cloudflare Worker that ingests email newsletters and exposes them as private RSS/Atom feeds. Self-hosted, free-tier-friendly (Cloudflare + ForwardEmail).

## Development approach

Work **test-first (TDD)** and **domain-driven (DDD)** in this repo — both are first-class, not optional.

**TDD.** Write or extend a test before/with the change, then make it pass. Mirror the existing test layout (`*.test.ts` next to the source, `createMockEnv()` from `src/test/setup.ts`, MSW for outbound HTTP). End every change green: `npx tsc --noEmit`, `npm test`, and `npm run build` (dry-run deploy) must all pass before declaring done.

**DDD.** Before adding logic, check whether the domain already models the concept — reach for the value objects in `src/domain/value-objects/` (`EmailAddress`, `Domain`, `FeedId`, `MailboxId`, `Lifetime`, `SenderPolicy`) and the `Feed` aggregate rather than re-deriving things ad hoc. New behavior belongs on the type that owns the data (e.g. "sender site URL" lives on `EmailAddress`, not in a helper). Respect the layering and aggregate rules below — imports point inward (routes → application → domain; infrastructure implements ports), and never reach across a layer for convenience (e.g. importing a favicon/infra helper just to parse a domain). When the same derivation appears twice, that's the signal to push it onto a domain type.

## Architecture

Single Cloudflare Worker built with Hono. Routes:

| Method                               | Path                                                                   | Purpose |
| ------------------------------------ | ---------------------------------------------------------------------- | ------- |
| `GET /`                              | Public status page (monitoring counters + link to admin)               |
| `POST /api/inbound`                  | Webhook from ForwardEmail; IP-allowlisted to their MX sources          |
| `/api/v1/feeds*`                     | Versioned REST API (Bearer/proxy auth) — feeds + emails CRUD           |
| `GET /api/v1/stats`                  | Public monitoring counters (JSON, CORS); canonical stats endpoint      |
| `GET /api/openapi.json`              | OpenAPI 3.1 spec (public)                                              |
| `GET /api/docs`                      | Rendered API reference (Scalar, public)                                |
| `GET /rss/:feedId`                   | Public RSS 2.0 feed (conditional GET: ETag/Last-Modified/304)          |
| `GET /atom/:feedId`                  | Public Atom feed (WebSub hub header; conditional GET ETag/304)         |
| `GET /json/:feedId`                  | Public JSON Feed                                                       |
| `GET /entries/:feedId/:entryId`      | Individual email HTML view                                             |
| `GET /files/:attachmentId/:filename` | R2 attachment serving                                                  |
| `GET /admin`                         | Password-protected admin UI                                            |
| `GET /admin/opml`                    | OPML export of all feeds (admin-protected)                             |
| `/hub`                               | WebSub hub (subscribe/publish)                                         |
| `GET /favicon.svg`, `/favicon.ico`   | Project favicon (envelope logo); fallback for per-feed favicons        |
| `GET /favicon/:feedId`               | Per-feed favicon from the last sender's domain (falls back to project) |
| `GET /health`                        | Health check                                                           |
| `email`                              | Cloudflare Email routing handler (alternative to ForwardEmail webhook) |

### Source layout

```
src/
  index.ts                  # App entrypoint: CORS, IP middleware, route mounting, email handler export
  config/constants.ts       # Shared constants (TTLs, limits)
  types/index.ts            # Env, FeedConfig, EmailData, WebSubSubscription, etc.
  domain/                   # Framework-agnostic core (no Hono/infra imports leak out)
    feed.aggregate.ts       # Feed aggregate: consistency boundary; holds domain FeedState (camelCase), exposes intention-revealing reads, never raw state/metadata
    feed-state.ts           # FeedState: the aggregate's config in domain (camelCase) vocabulary — NOT the snake_case persistence DTO
    feed.ts                 # The expiry predicate (`isExpired`) — the one invariant shared with the read-model routes
    feed-keys.ts            # The KV key schema (pure string builders), shared by every repository
    clock.ts                # Clock port (systemClock) — injected into the aggregate; no ambient Date.now()
    events.ts               # FeedEvent union (FeedCreated, EmailIngested) — each carries its feedId
    email-parser.ts         # Email parsing (addresses, headers, encoded words)
    format.ts               # Pure formatting helpers (formatBytes)
    native-feed.ts          # Detect a newsletter's self-advertised Atom/RSS/JSON feed (pure)
    value-objects/          # FeedId (opaque read id), MailboxId (inbound noun.noun.NN), EmailAddress, Domain, SenderPolicy, Lifetime (immutable, self-validating)
  application/              # Use-cases / orchestration (wires domain + infrastructure)
    feed-service.ts         # createFeedRecord / editFeedDetails / editFeed / deleteFeedRecord (admin UI + REST API)
    feed-cleanup.ts         # Feed/email storage cleanup: purgeFeedKeysStep, collectUnsubscribeUrls, attachment+key deletion
    feed-events.ts          # Dispatcher: maps aggregate FeedEvents to side effects (counters, WebSub, favicon)
    email-processor.ts      # Core ingestion: load aggregate → accepts? → feed.ingest → persist
    feed-fetcher.ts         # Read model for RSS/Atom rendering (config + email bodies; bypasses the aggregate)
    stats.ts                # Monitoring counters increment policy + storage scans
  infrastructure/          # Adapters: KV/R2, outbound HTTP, logging, framework glue
    logger.ts               # JSON structured logger
    feed-repository.ts      # KV adapter for the Feed aggregate + global feed list + email bodies (load/save)
    feed-mapper.ts          # Translation seam: domain FeedState ↔ persistence DTOs (FeedConfig/FeedListItem); sole owner of snake_case outside the edge
    icon-repository.ts      # KV adapter for cached favicons (icon:*)
    websub-subscription-repository.ts # KV adapter for WebSub subscriber lists (websub:subs:*)
    counters-repository.ts  # KV adapter for the monitoring counters singleton (stats:counters)
    auth.ts                 # timingSafeEqual, proxy-auth check, API bearer middleware
    cloudflare-email.ts     # Cloudflare Email routing handler
    forwardemail.ts         # ForwardEmail webhook types/parsing
    worker.ts               # Typed worker / waitUntil helper
    attachments.ts          # R2 bucket accessor
    favicon-fetcher.ts      # Outbound favicon fetch + cache (uses IconRepository)
    feed-generator.ts       # RSS/Atom/JSON Feed XML+JSON generation
    http-cache.ts           # Conditional-GET validators (ETag/Last-Modified) for feed routes
    html-processor.ts       # Email HTML sanitization / inline cid: rewriting
    websub.ts               # WebSub subscription management + delivery
    unsubscribe.ts          # RFC 8058 one-click unsubscribe dispatch
    urls.ts                 # URL builders
  routes/
    inbound.ts              # ForwardEmail webhook handler
    rss.ts                  # RSS feed renderer
    atom.ts                 # Atom feed renderer
    json.ts                 # JSON Feed renderer
    opml.ts                 # OPML export of all feeds (admin-protected handler)
    entries.ts              # Single email HTML view
    files.ts                # R2 attachment serving
    hub.ts                  # WebSub hub
    home.tsx                # Public status page (GET /)
    admin.tsx               # Admin UI entrypoint (hono/jsx)
    admin/                  # Admin sub-modules
      feeds.tsx             # Feeds CRUD UI
      emails.tsx            # Emails list/delete UI
      ui.tsx                # Shared UI components
      helpers.ts            # Shared admin helpers
    api/                    # Versioned REST API (@hono/zod-openapi)
      index.ts             # OpenAPIHono app: /v1 routes + /openapi.json + /docs
      schemas.ts           # Zod schemas (validation + OpenAPI source of truth)
  scripts/
    client/                 # TypeScript client scripts (compiled by esbuild)
      dashboard.ts          # Admin dashboard interactions
      emails-page.ts        # Emails page interactions
    generated/              # Compiled output (gitignored, rebuilt on npm install)
  styles/                   # CSS files bundled into the Worker
    variables.css
    layout.css
    components.css
    utilities.css
  data/nouns.ts             # Word list for ID generation
  test/setup.ts             # Test mocks: MockKV, createMockEnv()
```

### KV schema

All data lives in the `EMAIL_STORAGE` KV namespace:

| Key                         | Value                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `feeds:list`                | `{ feeds: Array<{ id, title, description?, mailbox_id?, expires_at? }> }`                                                                                                 |
| `feed:<feedId>:config`      | `FeedConfig`                                                                                                                                                              |
| `feed:<feedId>:metadata`    | `{ emails: Array<{ key, subject, receivedAt, size?, attachmentIds?, inlineAttachmentIds? }>, nativeFeeds?: Record<string, NativeFeed[]>, nativeFeedDismissed?: boolean }` |
| `feed:<feedId>:<timestamp>` | Full `EmailData`                                                                                                                                                          |
| `inbound:<mailboxId>`       | The feed id this inbound address (`noun.noun.NN`) routes to (resolved only at reception)                                                                                  |
| `websub:subs:<feedId>`      | `WebSubSubscription[]` (per-feed subscriber list)                                                                                                                         |
| `icon:<domain>`             | Cached favicon record (base64 + content type; negative entries allowed)                                                                                                   |
| `stats:counters`            | `Counters` (cumulative monitoring counters singleton)                                                                                                                     |

`feedId` is an **opaque random token** — the feed's identity, its KV storage key, and the public read id (`/rss/:feedId`). It is **decoupled** from the inbound email address: each feed also has a friendly `MailboxId` (`noun.noun.NN`) whose only mapping to the feed is the `inbound:<mailboxId>` secondary index, read **only** at email reception. So the feed's read URL never reveals its inbound address and vice-versa; reading `/rss/<noun.noun.NN>` 404s.

The KV key schema lives in `src/domain/feed-keys.ts` (pure, framework-agnostic) — never inline a `feed:`/`feeds:list`/`inbound:`/`websub:`/`icon:`/`stats:counters` key string anywhere else. KV access is owned by four repository **adapters** in `src/infrastructure/`, each for one concern: `FeedRepository` (the Feed aggregate + global list + email bodies), `IconRepository` (`icon:*`), `WebSubSubscriptionRepository` (`websub:subs:*`), and `CountersRepository` (`stats:counters`). Go through a repository, never `env.EMAIL_STORAGE.get/put` directly. The domain depends only on the key schema, not on these adapters.

### Domain & layering rules

- **Layers**: `domain/` is framework-agnostic (no Hono). `application/` orchestrates use-cases. `infrastructure/` holds adapters (KV/R2, HTTP, logging). `routes/` is the HTTP edge. Imports point inward: routes → application → domain; infrastructure implements ports the inner layers call.
- **The `Feed` aggregate is the only writer of feed config + the email index.** Load it with `FeedRepository.load(feedId)`, mutate via its methods (`ingest`, `removeEmails`, `edit`), then persist with `save`/`saveMetadata`/`saveConfig`. No route or service mutates `metadata.emails` directly. Email **bodies** are large blobs outside the aggregate — flush them (`putEmail`/`deleteEmail`) alongside the metadata save.
  - **The domain never speaks the storage dialect.** The aggregate holds its config as domain `FeedState` (camelCase), never the snake_case `FeedConfig` DTO. The translation `FeedState ↔ FeedConfig/FeedListItem` lives in `infrastructure/feed-mapper.ts` — the only place outside the HTTP edge that knows the persisted field names. `FeedRepository.load` maps DTO→state on the way in; `save`/`saveConfig` map state→DTO on the way out.
  - **The aggregate never exposes its raw state.** It has no `state`/`metadata` getters (a shallow `Readonly<…>` would still leak mutable arrays). Read named accessors (`title`, `expiresAt`, `emails`, `allowedSenders()`, …) which return copies; the repository reads `state()`/`toMetadataSnapshot()` (copies) and runs them through the mapper.
  - **One edit path.** `edit(patch, { lifetime? })` is the single mutation for config. A `Lifetime` VO is resolved by the application (env `FEED_TTL_HOURS` override + client request); its **presence recomputes expiry, its absence preserves it** — which is exactly the dashboard's title/description quick-edit (no lifetime passed). It rejects an already-expired feed, so a quick-edit can no more touch an expired feed than a full edit can.
  - **`feeds:list` and the `inbound:` index stay in sync automatically.** `FeedRepository.save`/`saveConfig` upsert the registry entry via `toListItemDTO(feed.id, feed.state())` _and_ write the `inbound:<mailbox> → feedId` index — services never mirror title/description/expiry into the list by hand. Symmetrically, `removeFromList`/`removeFromListBulk` drop the inbound index (the mailbox is cached on the list item) — so the index lives outside the `feed:<id>:` prefix the key purge sweeps, but is still cleared wherever a feed leaves the list (`deleteFeedRecord`, bulk admin delete, the cron). `deleteFeedFastDetailed` only removes config+metadata; it does **not** touch the index.
  - Read-only RSS/Atom rendering uses the `feed-fetcher` read model, not the aggregate (no invariant to enforce on the hot path).
  - KV has no multi-key transaction; the aggregate is the seam a future Durable Object would wrap to serialise concurrent ingests (see `email-processor.ts`).
  - **Side effects via domain events.** Mutations with consequences record a `FeedEvent` (`FeedCreated`, `EmailIngested`), each carrying its own `feedId`. After persisting, the caller hands the aggregate to `application/feed-events.dispatchFeedEvents(feed, env, schedule)` — the single dispatch entry point that drains `pullEvents()` and runs the counters/WebSub/favicon. Don't pull events or thread the feed id by hand at call sites. Side effects with no aggregate mutation (a rejected email, feed deletion that bypasses the aggregate, bulk admin ops, the cron) stay imperative — they have no event to ride on.
- **`FeedId` flows through the layers.** It is the identity type taken by the domain (`Feed.id`), the application use-cases (`editFeed`, `editFeedDetails`, `deleteFeedRecord`, `fetchFeedData`, the cleanup steps) and the infrastructure repositories/services (`FeedRepository`, `WebSubSubscriptionRepository`, `notifySubscribers`, …). Mint it **once** at the edge — `FeedId.generate()` (opaque) for a new feed, `FeedId.unchecked(param)` at the read/HTTP edge (no revalidation: a bad id just misses in KV and 404s) — then pass the VO inward. Unwrap to `.value` (string) only at the true serialisation edges: URL builders (`urls.ts`), XML generation (`feed-generator.ts`), the KV key schema (`feed-keys.ts`), logs and JSON responses.
- **`FeedId` (read) vs `MailboxId` (write) are distinct identities.** `MailboxId` (`noun.noun.NN`) owns the inbound address and the untrusted-input boundary: `MailboxId.parse(address)` at reception is the only place an external string becomes a mailbox. Ingestion then resolves it to the feed via `FeedRepository.resolveInbound(mailbox)` and loads by the resulting `FeedId`. The mailbox is an attribute of the feed (held on `FeedState.mailboxId`, exposed as `Feed.mailboxId: MailboxId`, persisted as `mailbox_id`, projected into `feeds:list`); the `mailbox@domain` shape lives on the VO (`MailboxId.emailAddress(domain)`), with `urls.feedEmailAddress` only resolving the env domain. Never derive one id from the other — the decoupling is the privacy guarantee.

### Worker bindings (`Env`)

```ts
EMAIL_STORAGE: KVNamespace;    // All feed/email data
ADMIN_PASSWORD: string;        // Worker secret — never in config files
DOMAIN: string;                // e.g. "getmynews.app"
ATTACHMENT_BUCKET?: R2Bucket;  // R2 for email attachments
FEED_MAX_SIZE_BYTES?: string;  // Optional email size cap
PROXY_TRUSTED_IPS?: string;    // Trusted reverse-proxy IPs
PROXY_AUTH_SECRET?: string;    // Shared secret for proxy auth
```

### Client scripts

`src/scripts/client/` contains TypeScript that runs in the browser. It is compiled by esbuild into `src/scripts/generated/` (gitignored) and bundled into the Worker as inline `<script>` tags. The `prepare` npm hook rebuilds them on `npm install`. Run `npm run build:client` to rebuild manually.

### Testing

Tests run in Node (not a Worker runtime). Hono test requests pass the mock env as the 3rd argument:

```ts
const res = await app.request("/path", init, createMockEnv());
```

MSW (`msw/node`) handles external HTTP mocks. Tests that hit validation paths intentionally produce stderr output — expected.

## Configuration

- `wrangler.toml` is generated locally from `wrangler-example.toml` by `setup.sh` — do not commit it
- `ADMIN_PASSWORD` is set via `wrangler secret put` — never in config files
- Keep `compatibility_date` current on runtime upgrades

## Releasing (read before cutting a release)

`package.json` `version` is inlined at build time as `APP_VERSION` (`src/config/version.ts`) and surfaced in the admin/status footer, `/health`, and `/api/v1/stats`. **`main` always carries a `-develop` pre-release suffix** (e.g. `0.4.0-develop`) so a dev build is never mistaken for a shipped one.

When asked to "release X.Y.Z", **run the script — never tag/bump/write notes by hand**:

```bash
npm run release X.Y.Z          # next dev cycle defaults to next minor
npm run release X.Y.Z A.B.C    # ...or pass an explicit next dev base (e.g. a patch line)
```

`X.Y.Z` must equal `main`'s current `X.Y.Z-develop` base. `scripts/release.sh` guards (clean tree, on `main`, synced with origin, version match, **non-empty `## [Unreleased]`**), then atomically: promotes `CHANGELOG.md`'s `## [Unreleased]` → `## [X.Y.Z]`, commits the **bare** `X.Y.Z` as a real release commit, tags it, opens the next `-develop` cycle (fresh `## [Unreleased]` + bump), and pushes `main` + the tag after a confirmation prompt.

The `v*` tag triggers the Release workflow (`.github/workflows/release.yml`), which **verifies** the tagged commit's `package.json` equals the tag exactly (wrong/`-develop`-commit guard), builds, and publishes a GitHub Release whose notes are the `## [X.Y.Z]` CHANGELOG section. **Release notes are never hand-typed** — they come from `CHANGELOG.md`, which you keep current under `## [Unreleased]` as part of every change (treat it like the other docs). Full flow in [CONTRIBUTING.md](CONTRIBUTING.md) under "Releasing".

## When changing behavior

**Always document evolutions** — treat docs as part of the change, not a follow-up. When you add or change a feature, update the relevant docs in the same change:

- `CHANGELOG.md` — add a bullet under `## [Unreleased]` for any user-facing change (this is what the next release notes are built from; never deferred to release time)
- `README.md`
- `INSTALL.md` (setup, deployment, and configuration guide)
- `setup.sh` (if setup/deploy assumptions changed)
- Tests under `src/routes/*.test.ts` and `src/test/setup.ts`

Keep it proportionate: user-facing or config changes warrant doc updates; purely internal refactors usually don't.

**Marketing landing page (`docs/index.html`).** This is the public GH Pages site (served at the `CNAME` domain), not the in-app status page (`src/routes/home.tsx`). When a feature is also a selling point — something a prospective self-hoster would care about (privacy guarantees, full-body capture, burnable aliases, reader compatibility, automation/API, AI features…) — surface it there too (hero copy or a feature card), matching the existing section/card style. Internal correctness fixes don't belong on the landing page; differentiators do.
