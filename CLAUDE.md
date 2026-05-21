# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install          # Install dependencies
npm run dev          # Start local dev server (wrangler dev)
npm test             # Run tests once
npm run test:watch   # Run tests in watch mode
npm run test:coverage # Run tests with coverage report
npm run build        # Dry-run deploy bundle (wrangler deploy --dry-run)
npm run deploy       # Deploy to Cloudflare production
npm run format       # Format with Prettier
```

Run a single test file:

```bash
npx vitest run src/routes/admin.test.ts
```

## Architecture

Cloudflare Worker built with Hono. A single Worker handles three route groups:

- `POST /api/inbound` — ForwardEmail webhook; IP-restricted to ForwardEmail MX sources (verified dynamically via `https://forwardemail.net/ips/v4.json`, with in-memory cache + static fallback)
- `GET /rss/:feedId` — public RSS feed rendered from KV
- `/admin` — password-protected admin UI (server-rendered HTML with inline scripts)

### Key files

| File                    | Purpose                                                                  |
| ----------------------- | ------------------------------------------------------------------------ |
| `src/index.ts`          | App entrypoint: CORS middleware, IP allowlist middleware, route mounting |
| `src/routes/inbound.ts` | Email ingestion: validates, parses, stores to KV                         |
| `src/routes/rss.ts`     | Reads KV and renders RSS XML                                             |
| `src/routes/admin.ts`   | Admin UI (HTML) and feed/email CRUD API                                  |
| `src/types/index.ts`    | Shared TypeScript types (`Env`, `FeedConfig`, `EmailData`, etc.)         |
| `src/test/setup.ts`     | Test mocks for KV (`MockKV`) and Cache; exports `createMockEnv()`        |

### KV schema

All data lives in the `EMAIL_STORAGE` KV namespace:

| Key                         | Value                                             |
| --------------------------- | ------------------------------------------------- |
| `feeds:list`                | `{ feeds: Array<{ id, title, description? }> }`   |
| `feed:<feedId>:config`      | `FeedConfig` object                               |
| `feed:<feedId>:metadata`    | `{ emails: Array<{ key, subject, receivedAt }> }` |
| `feed:<feedId>:<timestamp>` | Full `EmailData` object                           |

`src/utils/storage.ts` contains alternate key helpers not used by routes — keep route key usage consistent with the schema above.

### Admin UI architecture

The admin UI is server-rendered HTML returned by `src/routes/admin.ts`. Interactive behavior (toast notifications, clipboard, bulk delete, table column resizing/sorting) is implemented as inline scripts in `src/scripts/`. Styles are composed from `src/styles/`. These are bundled into the Worker — there is no separate frontend build step.

### Testing

Tests run in Node (not a Worker runtime). Hono test requests pass the mock env as the 3rd argument:

```ts
const res = await app.request("/path", init, createMockEnv());
```

MSW (`msw/node`) handles external HTTP mocks. Tests that hit validation paths intentionally produce stderr output — this is expected.

### Worker environment bindings (`Env`)

```ts
EMAIL_STORAGE: KVNamespace; // KV namespace for all data
ADMIN_PASSWORD: string; // Cloudflare Worker secret (not in wrangler.toml)
DOMAIN: string; // e.g. "yourdomain.com"
```

## Configuration

- `wrangler.toml` is generated locally from `wrangler-example.toml` by `setup.sh` — do not commit `wrangler.toml`
- `ADMIN_PASSWORD` is a Cloudflare Worker secret set via `wrangler secret put`; it is never in config files
- Keep `compatibility_date` current on runtime upgrades

## When changing behavior

Update these together:

- `README.md`
- `AGENTS.md`
- `setup.sh` (if setup/deploy assumptions changed)
- Tests under `src/routes/*.test.ts` and `src/test/setup.ts`
