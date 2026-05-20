# Email-to-RSS

Convert email newsletters into a private RSS feed using Cloudflare Workers.

This project is self-hosted, uses your own domain, and keeps your data in your own Cloudflare account.

## Why this exists

Many newsletters only support email delivery. RSS readers offer a better reading experience, but getting email-only newsletters into RSS usually means relying on shared third-party infrastructure.

Email-to-RSS keeps the same workflow while avoiding shared domains and shared data stores.

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
- Cloudflare KV storage for feed config + email metadata/content
- Password-protected admin UI

## Architecture

Two ingestion methods are supported — pick one or use both:

| Method | How it works |
| ---------------------- | ------------------------------------------------------------------ |
| **Cloudflare Email Workers** | Cloudflare Email Routing delivers the raw message directly to the Worker via the `email()` handler — no outbound webhook needed |
| **ForwardEmail webhook** | ForwardEmail parses the message and POSTs a JSON payload to `POST /api/inbound`; the Worker verifies the source IP before processing |

Common path:

1. Incoming email arrives at `user@yourdomain.com`.
2. The Worker resolves the feed from the recipient address and stores the email in KV.
3. `https://yourdomain.com/rss/:feedId` renders RSS from stored items.
4. `/admin` provides feed management and email deletion.

Main routes:

- `src/lib/cloudflare-email.ts`: Cloudflare Email Workers ingestion
- `src/routes/inbound.ts`: ForwardEmail webhook ingestion
- `src/routes/rss.ts`: RSS rendering
- `src/routes/admin.ts`: admin UI + feed CRUD

## Requirements

- Node.js 20+
- A Cloudflare account (free plan works — Workers, KV, and Email Routing are all included)
- A domain added to Cloudflare as a zone (DNS managed by Cloudflare)
- A ForwardEmail account _(Option B only)_

## Cloudflare setup

If your domain is not yet on Cloudflare: in the [Cloudflare dashboard](https://dash.cloudflare.com/), go to *Add a site*, enter your domain, choose the Free plan, and follow the instructions to update your nameservers at your registrar. Wait for the zone to become active (usually a few minutes).

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

1. In the Cloudflare dashboard, go to *Email → Email Routing* for your zone and click **Enable Email Routing**. Cloudflare will prompt you to add MX and SPF records — accept and it adds them automatically.
2. Under *Email Routing → Routing Rules*, add a **Catch-all** rule:
   - Action: **Send to Worker**
   - Worker: `email-to-rss` (the name from `wrangler.toml`)

That's it. No webhook configuration is needed.

### Option B — ForwardEmail (alternative)

Use this if you prefer ForwardEmail's additional features (sender filtering, open-tracking, etc.).

Add these DNS records in Cloudflare (*DNS → Records*):

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

> **Tip:** To verify the Worker is running, check *Workers & Pages → email-to-rss* in the Cloudflare dashboard. The *Custom Domains* tab should list your domain once the deploy succeeds.

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

## Security notes

- When using Option B (ForwardEmail), inbound webhook access is IP-restricted to ForwardEmail MX sources.
- Admin auth uses a signed, `HttpOnly`, `Secure`, `SameSite=Strict` cookie.
- Admin responses are `no-store` to avoid cache leakage.
- For high-value feeds, set `Allowed senders` so only known sender addresses/domains are accepted.
- You should use a strong admin password and rotate periodically.

## Upgrading dependencies

To refresh dependencies to latest:

```bash
npm outdated
npm install
npm test
npm run build
```

Then update `compatibility_date` and redeploy.

## License

MIT
