# kill-the-news

Convert email newsletters into private RSS feeds using Cloudflare Workers.

Self-hosted, uses your own domain, and keeps your data in your own Cloudflare account. Live at [kill-the.news](https://kill-the.news).

## Why this exists

Many newsletters only support email delivery. RSS readers offer a better reading experience, but getting email-only newsletters into RSS usually means relying on shared third-party infrastructure.

kill-the-news keeps the same workflow while avoiding shared domains and shared data stores.

## Features

- One-click feed creation from an admin dashboard
- Bulk feed/email deletion from the admin dashboard (safe checkbox-based flow)
- Inline double-confirm delete interactions with toast feedback in the admin dashboard
- Resizable + sortable table columns in the admin dashboard (Table view)
- Unique newsletter addresses per feed (for example `apple.mountain.42@yourdomain.com`)
- Cloudflare Email Workers ingestion (no third-party service)
- ForwardEmail webhook ingestion with source-IP verification (optional alternative)
- Optional per-feed sender allowlist (`email@domain.com` or `domain.com`)
- RSS generation on demand (`/rss/:feedId`)
- Atom feed at `/atom/:feedId`
- Per-feed favicon derived from the last sender's domain (`/favicon/:feedId`), cached and shown in feeds + admin
- Automatic RFC 8058 one-click unsubscribe when a feed is deleted — stops newsletters from mailing the now-dead address
- Email attachments stored in Cloudflare R2 and exposed as RSS enclosures (optional)
- Cloudflare KV storage for feed config + email metadata/content
- Password-protected admin UI
- Versioned REST API (`/api/v1/*`) with an OpenAPI 3.1 spec and Scalar docs for automation

## Architecture

Two ingestion methods are supported — pick one or use both:

| Method                       | How it works                                                                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **Cloudflare Email Workers** | Cloudflare Email Routing delivers the raw message directly to the Worker via the `email()` handler — no outbound webhook needed      |
| **ForwardEmail webhook**     | ForwardEmail parses the message and POSTs a JSON payload to `POST /api/inbound`; the Worker verifies the source IP before processing |

Common path:

1. Incoming email arrives at `user@yourdomain.com`.
2. The Worker resolves the feed from the recipient address and stores the email in KV.
3. `https://yourdomain.com/rss/:feedId` renders RSS from stored items.
4. `/admin` provides feed management and email deletion.
5. `https://yourdomain.com/` shows a public status page with monitoring counters and a link to the admin.

Main routes:

- `src/lib/cloudflare-email.ts`: Cloudflare Email Workers ingestion
- `src/routes/inbound.ts`: ForwardEmail webhook ingestion
- `src/routes/rss.ts`: RSS rendering
- `src/routes/atom.ts`: Atom feed rendering
- `src/routes/files.ts`: attachment file serving from R2
- `src/routes/admin.tsx`: admin UI + feed CRUD
- `src/routes/api/`: versioned REST API + OpenAPI spec/docs (`/api/v1/*`, `/api/openapi.json`, `/api/docs`)
- `src/lib/feed-service.ts`: shared feed create/update/delete (used by the admin UI and the REST API)
- `src/routes/home.tsx`: public status page (`GET /`)
- `src/routes/stats.ts`: monitoring counters API (`GET /api/stats`)

### Monitoring

`GET /api/v1/stats` returns JSON counters (public, no auth, CORS-enabled) for
uptime/monitoring tools and the landing page. `GET /api/stats` is a deprecated alias kept
for backward compatibility — prefer the versioned path. Both expose the same fields:

| Field                         | Meaning                                                  |
| ----------------------------- | -------------------------------------------------------- |
| `active_feeds`                | Feeds currently configured (live)                        |
| `feeds_created`               | Total feeds ever created (cumulative)                    |
| `feeds_deleted`               | Total feeds ever deleted (cumulative)                    |
| `emails_received`             | Total emails ingested successfully (cumulative)          |
| `emails_rejected`             | Total emails rejected during validation (cumulative)     |
| `websub_subscriptions_active` | Active WebSub subscriptions (live)                       |
| `last_email_at`               | ISO 8601 date-time of the last ingested email            |
| `last_feed_created_at`        | ISO 8601 date-time of the last feed creation             |
| `first_seen`                  | ISO 8601 date-time the instance first recorded a counter |

The same figures are rendered on the public status page at `GET /`. Cumulative counters
are persisted in the `EMAIL_STORAGE` KV under the `stats:counters` key.

### REST API

A versioned REST API lets you automate feed and email management without scraping the
admin UI. The OpenAPI 3.1 spec is served at `GET /api/openapi.json` and a rendered
reference (Scalar) at `GET /api/docs` — both public.

The feed and email endpoints require authentication, using either:

- **Bearer token**: `Authorization: Bearer <ADMIN_PASSWORD>`, or
- **Reverse-proxy auth**: the same trusted-IP + `X-Auth-Proxy-Secret` + `Remote-User`
  headers as the admin UI (see [INSTALL.md](INSTALL.md)).

`GET /api/v1/stats`, the OpenAPI spec, and the docs page are public.

| Method   | Path                                 | Auth   | Purpose                  |
| -------- | ------------------------------------ | ------ | ------------------------ |
| `GET`    | `/api/v1/feeds`                      | yes    | List feeds               |
| `POST`   | `/api/v1/feeds`                      | yes    | Create a feed            |
| `GET`    | `/api/v1/feeds/{feedId}`             | yes    | Get a feed               |
| `PATCH`  | `/api/v1/feeds/{feedId}`             | yes    | Update a feed            |
| `DELETE` | `/api/v1/feeds/{feedId}`             | yes    | Delete a feed            |
| `GET`    | `/api/v1/feeds/{feedId}/emails`      | yes    | List a feed's emails     |
| `GET`    | `/api/v1/feeds/{feedId}/emails/{id}` | yes    | Get a single email       |
| `DELETE` | `/api/v1/feeds/{feedId}/emails/{id}` | yes    | Delete a single email    |
| `GET`    | `/api/v1/stats`                      | public | Read monitoring counters |

The email `{id}` is the email's `receivedAt` timestamp (as returned by the list endpoint).

```bash
# Create a feed
curl -X POST https://yourdomain.com/api/v1/feeds \
  -H "Authorization: Bearer $ADMIN_PASSWORD" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Daily Digest","allowedSenders":["news@example.com"]}'
```

## Installation

See **[INSTALL.md](INSTALL.md)** for the full setup, deployment, and configuration guide. Quick start:

```bash
npx wrangler login
bash setup.sh        # prompts for admin password + domain, provisions KV, generates wrangler.toml
npm run deploy       # deploys the Worker and registers your custom domain
```

Then enable email ingestion (Cloudflare Email Workers or ForwardEmail) and open `https://yourdomain.com/admin`. Details, options, and configuration knobs (feed size limit, R2 attachments, reverse-proxy auth, CI deploys) are all in [INSTALL.md](INSTALL.md).

## Security notes

- When using Option B (ForwardEmail), inbound webhook access is IP-restricted to ForwardEmail MX sources.
- Admin auth uses a signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- Admin responses are `no-store` to avoid cache leakage.
- For high-value feeds, set `Allowed senders` so only known sender addresses/domains are accepted.
- You should use a strong admin password and rotate periodically.
- All secret comparisons (admin password, proxy secret) use constant-time comparison to prevent timing attacks.

## Acknowledgements

- [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter) by Leandro Facchinetti — the inspiration for this project and the reference implementation for feature ideas (Atom feeds, attachment enclosures, entry HTML views, and more).
- [Email-to-RSS](https://github.com/yl8976/Email-to-RSS) by yl8976 — the initial codebase this project is based on.

## License

MIT
