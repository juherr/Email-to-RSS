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
| `GET /api/stats`                     | Public monitoring counters (JSON)                                      |
| `GET /rss/:feedId`                   | Public RSS 2.0 feed                                                    |
| `GET /atom/:feedId`                  | Public Atom feed (with WebSub hub header)                              |
| `GET /entries/:feedId/:entryId`      | Individual email HTML view                                             |
| `GET /files/:attachmentId/:filename` | R2 attachment serving                                                  |
| `GET /admin`                         | Password-protected admin UI                                            |
| `/hub`                               | WebSub hub (subscribe/publish)                                         |
| `GET /favicon.svg`, `/favicon.ico`   | Project favicon (envelope logo); fallback for per-feed favicons        |
| `GET /health`                        | Health check                                                           |
| `email`                              | Cloudflare Email routing handler (alternative to ForwardEmail webhook) |

### Source layout

```
src/
  index.ts                  # App entrypoint: CORS, IP middleware, route mounting, email handler export
  config/constants.ts       # Shared constants (TTLs, limits)
  types/index.ts            # Env, FeedConfig, EmailData, WebSubSubscription, etc.
  routes/
    inbound.ts              # ForwardEmail webhook handler
    rss.ts                  # RSS feed renderer
    atom.ts                 # Atom feed renderer
    entries.ts              # Single email HTML view
    files.ts                # R2 attachment serving
    hub.ts                  # WebSub hub
    home.tsx                # Public status page (GET /)
    stats.ts                # Monitoring counters API (GET /api/stats)
    admin.tsx               # Admin UI entrypoint (hono/jsx)
    admin/                  # Admin sub-modules
      feeds.tsx             # Feeds CRUD UI
      emails.tsx            # Emails list/delete UI
      ui.tsx                # Shared UI components
      helpers.ts            # Shared admin helpers
  lib/
    cloudflare-email.ts     # Cloudflare Email routing handler
    email-parser.ts         # Email parsing (mailparser)
    email-processor.ts      # Core ingestion logic (parse → store)
    feed-fetcher.ts         # KV feed/email fetch helpers
    feed-generator.ts       # RSS/Atom XML generation
    forwardemail.ts         # ForwardEmail webhook types/parsing
    id-generator.ts         # Feed/entry ID generation
    logger.ts               # JSON structured logger
    storage.ts              # KV key helpers
    websub.ts               # WebSub subscription management
    worker.ts               # Typed worker export helper
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

| Key                              | Value                                                                    |
| -------------------------------- | ------------------------------------------------------------------------ |
| `feeds:list`                     | `{ feeds: Array<{ id, title, description? }> }`                          |
| `feed:<feedId>:config`           | `FeedConfig`                                                             |
| `feed:<feedId>:metadata`         | `{ emails: Array<{ key, subject, receivedAt, size?, attachmentIds? }> }` |
| `feed:<feedId>:<timestamp>`      | Full `EmailData`                                                         |
| `websub:<feedId>:<callbackHash>` | `WebSubSubscription`                                                     |
| `stats:counters`                 | `Counters` (cumulative monitoring counters singleton)                    |

`src/lib/storage.ts` contains key-builder helpers — use them; don't inline key strings in routes.

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
- `AGENTS.md`
- `setup.sh` (if setup/deploy assumptions changed)
- Tests under `src/routes/*.test.ts` and `src/test/setup.ts`
