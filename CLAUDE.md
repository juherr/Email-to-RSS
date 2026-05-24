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
| `GET /rss/:feedId`                   | Public RSS 2.0 feed                                                    |
| `GET /atom/:feedId`                  | Public Atom feed (with WebSub hub header)                              |
| `GET /entries/:feedId/:entryId`      | Individual email HTML view                                             |
| `GET /files/:attachmentId/:filename` | R2 attachment serving                                                  |
| `GET /admin`                         | Password-protected admin UI                                            |
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
    feed.aggregate.ts       # Feed aggregate: consistency boundary; all config/metadata mutations go through it
    feed.ts                 # Pure invariant functions (expiry, sender policy, byte budget) the aggregate delegates to
    feed-keys.ts            # The KV key schema (pure string builders), shared by every repository
    clock.ts                # Clock port (systemClock) — injected into the aggregate; no ambient Date.now()
    email-parser.ts         # Email parsing (addresses, headers, encoded words)
    format.ts               # Pure formatting helpers (formatBytes)
    value-objects/          # FeedId, EmailAddress, Domain, SenderPolicy (immutable, self-validating)
  application/              # Use-cases / orchestration (wires domain + infrastructure)
    feed-service.ts         # createFeedRecord / editFeedDetails / editFeed / deleteFeedRecord (admin UI + REST API)
    feed-cleanup.ts         # Feed/email storage cleanup: purgeFeedKeysStep, collectUnsubscribeUrls, attachment+key deletion
    email-processor.ts      # Core ingestion: load aggregate → accepts? → feed.ingest → persist
    feed-fetcher.ts         # Read model for RSS/Atom rendering (config + email bodies; bypasses the aggregate)
    stats.ts                # Monitoring counters increment policy + storage scans
  infrastructure/          # Adapters: KV/R2, outbound HTTP, logging, framework glue
    logger.ts               # JSON structured logger
    feed-repository.ts      # KV adapter for the Feed aggregate + global feed list + email bodies (load/save)
    icon-repository.ts      # KV adapter for cached favicons (icon:*)
    websub-subscription-repository.ts # KV adapter for WebSub subscriber lists (websub:subs:*)
    counters-repository.ts  # KV adapter for the monitoring counters singleton (stats:counters)
    auth.ts                 # timingSafeEqual, proxy-auth check, API bearer middleware
    cloudflare-email.ts     # Cloudflare Email routing handler
    forwardemail.ts         # ForwardEmail webhook types/parsing
    worker.ts               # Typed worker / waitUntil helper
    attachments.ts          # R2 bucket accessor
    favicon-fetcher.ts      # Outbound favicon fetch + cache (uses IconRepository)
    feed-generator.ts       # RSS/Atom XML generation
    html-processor.ts       # Email HTML sanitization / inline cid: rewriting
    websub.ts               # WebSub subscription management + delivery
    unsubscribe.ts          # RFC 8058 one-click unsubscribe dispatch
    urls.ts                 # URL builders
  routes/
    inbound.ts              # ForwardEmail webhook handler
    rss.ts                  # RSS feed renderer
    atom.ts                 # Atom feed renderer
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

| Key                         | Value                                                                    |
| --------------------------- | ------------------------------------------------------------------------ |
| `feeds:list`                | `{ feeds: Array<{ id, title, description?, expires_at? }> }`             |
| `feed:<feedId>:config`      | `FeedConfig`                                                             |
| `feed:<feedId>:metadata`    | `{ emails: Array<{ key, subject, receivedAt, size?, attachmentIds? }> }` |
| `feed:<feedId>:<timestamp>` | Full `EmailData`                                                         |
| `websub:subs:<feedId>`      | `WebSubSubscription[]` (per-feed subscriber list)                        |
| `icon:<domain>`             | Cached favicon record (base64 + content type; negative entries allowed)  |
| `stats:counters`            | `Counters` (cumulative monitoring counters singleton)                    |

The KV key schema lives in `src/domain/feed-keys.ts` (pure, framework-agnostic) — never inline a `feed:`/`feeds:list`/`websub:`/`icon:`/`stats:counters` key string anywhere else. KV access is owned by four repository **adapters** in `src/infrastructure/`, each for one concern: `FeedRepository` (the Feed aggregate + global list + email bodies), `IconRepository` (`icon:*`), `WebSubSubscriptionRepository` (`websub:subs:*`), and `CountersRepository` (`stats:counters`). Go through a repository, never `env.EMAIL_STORAGE.get/put` directly. The domain depends only on the key schema, not on these adapters.

### Domain & layering rules

- **Layers**: `domain/` is framework-agnostic (no Hono). `application/` orchestrates use-cases. `infrastructure/` holds adapters (KV/R2, HTTP, logging). `routes/` is the HTTP edge. Imports point inward: routes → application → domain; infrastructure implements ports the inner layers call.
- **The `Feed` aggregate is the only writer of feed config + the email index.** Load it with `FeedRepository.load(feedId)`, mutate via its methods (`ingest`, `removeEmails`, `editDetails`, `edit`), then persist with `save`/`saveMetadata`/`saveConfig`. No route or service mutates `metadata.emails` directly. Email **bodies** are large blobs outside the aggregate — flush them (`putEmail`/`deleteEmail`) alongside the metadata save.
  - Read-only RSS/Atom rendering uses the `feed-fetcher` read model, not the aggregate (no invariant to enforce on the hot path).
  - KV has no multi-key transaction; the aggregate is the seam a future Durable Object would wrap to serialise concurrent ingests (see `email-processor.ts`).
- **`FeedId`** is the type used by the domain (`Feed.id`) and every single-feed `FeedRepository` method. Wrap a raw id string with `FeedId.fromTrusted(value)` at the call site; keep `.value` (string) for URLs, logs, JSON and the feed-list registry. Mint new ids with `FeedId.generate()`.

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

## When changing behavior

Update together:

- `README.md`
- `INSTALL.md` (setup, deployment, and configuration guide)
- `setup.sh` (if setup/deploy assumptions changed)
- Tests under `src/routes/*.test.ts` and `src/test/setup.ts`
