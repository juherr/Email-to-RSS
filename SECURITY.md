# Security Policy

## Supported versions

kill-the-news is a self-hosted, single-Worker application. Only the latest
release on the `main` branch receives security fixes. If you run a fork or an
older deployment, update to the latest `main` before reporting an issue.

## Reporting a vulnerability

**Please do not open a public GitHub issue for security problems.**

Report privately through one of:

- [GitHub Security Advisories](https://github.com/juherr/kill-the-news/security/advisories/new) (preferred)
- Email: me@juherr.dev

Please include:

- A description of the issue and its impact
- Steps to reproduce (proof-of-concept if possible)
- Affected route, file, or configuration
- Any suggested remediation

You can expect an acknowledgement within a few days. Since this is a
volunteer-maintained project, fix timelines depend on severity and
availability, but credible reports are taken seriously. Coordinated disclosure
is appreciated — please give a reasonable window for a fix before going public.

## Scope

Because this Worker ingests email and exposes feeds, the security-sensitive
surface includes:

- **Admin authentication** — password handling, the signed session cookie, and
  constant-time secret comparison (`ADMIN_PASSWORD`, `PROXY_AUTH_SECRET`).
- **Inbound ingestion** — the ForwardEmail webhook (`POST /api/inbound`),
  IP allowlisting, and the Cloudflare Email Workers handler.
- **Email rendering** — HTML sanitization for stored emails and feed output
  (XSS via `entries/`, `rss/`, `atom/`, inline `cid:` images).
- **Public endpoints** — `GET /`, `GET /api/stats`, `GET /rss/:feedId`,
  `GET /atom/:feedId`, `GET /files/:attachmentId/:filename`,
  `GET /favicon/:feedId`.

### Out of scope

- Vulnerabilities in Cloudflare, ForwardEmail, or other third-party
  infrastructure (report those to the respective vendor).
- Misconfiguration of a self-hosted deployment (e.g. a weak `ADMIN_PASSWORD`,
  an exposed `workers.dev` subdomain, or committing secrets). See the security
  notes in [README.md](README.md) and [INSTALL.md](INSTALL.md).
- Denial of service from sending large volumes of email.

## Hardening reminders for operators

- Use a strong, unique `ADMIN_PASSWORD` and rotate it periodically.
- Set `ADMIN_PASSWORD` via `wrangler secret put` — never in config files.
- Disable the `workers.dev` subdomain in production (`workers_dev = false`),
  since `CF-Connecting-IP` can be spoofed on direct `workers.dev` requests.
- Set per-feed `Allowed senders` for high-value feeds.
- Never commit `wrangler.toml` or `.dev.vars` (both are gitignored).
