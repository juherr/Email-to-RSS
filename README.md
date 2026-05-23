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
- `src/routes/admin.ts`: admin UI + feed CRUD
- `src/routes/home.tsx`: public status page (`GET /`)
- `src/routes/stats.ts`: monitoring counters API (`GET /api/stats`)

### Monitoring

`GET /api/stats` returns JSON counters (public, no auth) for uptime/monitoring tools:

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

## Requirements

- Node.js 20+
- A Cloudflare account (free plan works — Workers, KV, and Email Routing are all included)
- A domain added to Cloudflare as a zone (DNS managed by Cloudflare)
- A ForwardEmail account _(Option B only)_

## Cloudflare setup

If your domain is not yet on Cloudflare: in the [Cloudflare dashboard](https://dash.cloudflare.com/), go to _Add a site_, enter your domain, choose the Free plan, and follow the instructions to update your nameservers at your registrar. Wait for the zone to become active (usually a few minutes).

## Setup

1. Clone this repository.
2. Authenticate Wrangler:
   ```bash
   npx wrangler login
   ```
3. Run setup:

   ```bash
   bash setup.sh
   ```

   The script will prompt for an admin password and your domain, then:
   - install npm dependencies
   - verify Cloudflare auth (`wrangler whoami`)
   - create KV namespaces (`EMAIL_STORAGE` + preview) in your account
   - set the `ADMIN_PASSWORD` secret in the `production` environment
   - generate `wrangler.toml` from `wrangler-example.toml` with your KV IDs, domain, and today's compatibility date

4. Configure email ingestion — choose **one** of the two options below.

### Option A — Cloudflare Email Workers (recommended)

No third-party service required. Cloudflare receives the email and hands it directly to the Worker.

1. In the Cloudflare dashboard, go to _Email → Email Routing_ for your zone and click **Enable Email Routing**. Cloudflare will prompt you to add MX and SPF records — accept and it adds them automatically.
2. Under _Email Routing → Routing Rules_, add a **Catch-all** rule:
   - Action: **Send to Worker**
   - Worker: `kill-the-news` (the name from `wrangler.toml`)

That's it. No webhook configuration is needed.

### Option B — ForwardEmail (alternative)

Use this if you prefer ForwardEmail's additional features (sender filtering, open-tracking, etc.).

Add these DNS records in Cloudflare (_DNS → Records_):

| Type | Name | Content                                              | Notes                   |
| ---- | ---- | ---------------------------------------------------- | ----------------------- |
| MX   | @    | `mx1.forwardemail.net`                               | Priority `10`, DNS only |
| MX   | @    | `mx2.forwardemail.net`                               | Priority `10`, DNS only |
| TXT  | @    | `"forward-email=https://yourdomain.com/api/inbound"` | webhook target          |
| TXT  | @    | `"v=spf1 include:spf.forwardemail.net -all"`         | SPF                     |

Replace `yourdomain.com` with your actual domain.

The Worker verifies each webhook request against ForwardEmail's published MX IP list before processing it.

5. Deploy:

   ```bash
   npm run deploy
   ```

   Wrangler will create the Worker and register `yourdomain.com` (and `www.yourdomain.com`) as custom domains pointing to it. Cloudflare handles TLS automatically.

6. Open `https://yourdomain.com/admin` and sign in.

> **Tip:** To verify the Worker is running, check _Workers & Pages → kill-the-news_ in the Cloudflare dashboard. The _Custom Domains_ tab should list your domain once the deploy succeeds.

## Development

```bash
npm install
npm run dev
npm test
npm run build
```

## Configuration notes

- `wrangler-example.toml` is the template; `wrangler.toml` is generated locally.
- Keep `compatibility_date` fresh when doing runtime upgrades.
- `ADMIN_PASSWORD` is a Cloudflare Worker secret, not a plain env var in config.

### Feed size limit

By default the worker keeps emails until the feed's stored data exceeds **512 KB**, then drops the oldest entries (and their KV records) to stay under the limit. This is more robust than a fixed entry count for HTML-heavy newsletters.

To override the threshold, add to `wrangler.toml` under `[vars]`:

```toml
FEED_MAX_SIZE_BYTES = "524288"   # 512 KB — adjust as needed
```

### Email attachments (R2)

When an incoming email contains attachments, the Worker can store them in a Cloudflare R2 bucket and expose them as `<enclosure>` elements in the RSS feed (and `<link rel="enclosure">` in Atom). Each attachment is served at `/files/{id}/{filename}` with an immutable cache header.

This feature is **optional**. If no R2 bucket is bound, attachments are silently ignored and nothing else changes.

**Setup:**

1. Create an R2 bucket in the Cloudflare dashboard (_R2 Object Storage → Create bucket_), or with Wrangler:
   ```bash
   npx wrangler r2 bucket create your-bucket-name
   ```
2. In `wrangler.toml`, uncomment and fill in the R2 binding (the commented block from `wrangler-example.toml`):
   ```toml
   r2_buckets = [
     { binding = "ATTACHMENT_BUCKET", bucket_name = "your-bucket-name", preview_bucket_name = "your-bucket-name-preview" }
   ]
   ```
   Do the same under `[env.production]` (without `preview_bucket_name`).
3. Redeploy:
   ```bash
   npm run deploy
   ```

Attachments are deleted from R2 automatically when the corresponding email is deleted from the admin UI, or when an email is dropped during feed size trimming.

### External auth provider (Authelia / Authentik / reverse proxy)

Instead of the built-in password login you can delegate admin authentication to a reverse proxy that sets a trusted user header (`Remote-User` or `X-Forwarded-User`).

**Required Worker secrets** (set with `wrangler secret put`, never in `[vars]`):

| Secret              | Description                                    |
| ------------------- | ---------------------------------------------- |
| `PROXY_AUTH_SECRET` | Shared secret between the proxy and the Worker |

**Required `[vars]`** in `wrangler.toml`:

```toml
PROXY_TRUSTED_IPS = "10.0.0.1"   # comma-separated IPs of your reverse proxy
```

When both are configured, the Worker authenticates a request if:

1. `CF-Connecting-IP` is in `PROXY_TRUSTED_IPS`
2. The `X-Auth-Proxy-Secret` header matches `PROXY_AUTH_SECRET`
3. `Remote-User` or `X-Forwarded-User` is non-empty

Password login remains available as a fallback when the proxy check fails.

> **Security note:** `CF-Connecting-IP` can be spoofed on direct `workers.dev` requests. Disable the `workers.dev` subdomain in production (`workers_dev = false` in `[env.production]`).

## Security notes

- When using Option B (ForwardEmail), inbound webhook access is IP-restricted to ForwardEmail MX sources.
- Admin auth uses a signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- Admin responses are `no-store` to avoid cache leakage.
- For high-value feeds, set `Allowed senders` so only known sender addresses/domains are accepted.
- You should use a strong admin password and rotate periodically.
- All secret comparisons (admin password, proxy secret) use constant-time comparison to prevent timing attacks.

## Upgrading dependencies

To refresh dependencies to latest:

```bash
npm outdated
npm install
npm test
npm run build
```

Then update `compatibility_date` and redeploy.

## Acknowledgements

- [kill-the-newsletter](https://github.com/leafac/kill-the-newsletter) by Leandro Facchinetti — the inspiration for this project and the reference implementation for feature ideas (Atom feeds, attachment enclosures, entry HTML views, and more).
- [Email-to-RSS](https://github.com/yl8976/Email-to-RSS) by yl8976 — the initial codebase this project is based on.

## License

MIT
