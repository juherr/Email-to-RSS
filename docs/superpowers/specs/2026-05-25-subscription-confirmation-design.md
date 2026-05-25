# Subscription confirmation surfacing — design

_Date: 2026-05-25 · Origin: TODO.md `P1·M` "Subscription confirmation handling" (upstream issues #5, #23, #57, #73, #89, #95, #97)_

## Problem

Newsletters require a "click to confirm your subscription" step. The confirmation
email lands in the feed like any other item, so the user has to hunt the link
inside a feed reader — the single most recurring upstream request. Until they
confirm, the feed stays empty and the tool looks broken.

## Goal (v1 scope)

Detect confirmation emails at ingestion, **mark** them, and **surface the
confirmation link prominently** in the admin so the user can click it. No outbound
requests — the worker never follows the link in v1.

Explicitly deferred to a later batch (noted in TODO): a server-configured
on-detection action (`none` / `autoclick` / `forward` to the fallback box).

## Non-goals

- No auto-clicking / server-side following of confirmation links (SSRF surface).
- No per-feed action configuration.
- No detection of whether confirmation actually succeeded (impossible without
  autoclick) — "dismiss" just stops the reminder.

## Architecture overview

Detection is a **pure domain service** fed by infra-extracted links/text; the
result is persisted on the email's metadata at ingestion and a feed-level flag is
projected into `feeds:list` so the dashboard stays at one KV read.

```
ingestion (storeEmail)
  ├─ infra: htmlToText(content) + extractLinks(content)
  ├─ domain: detectConfirmation({subject, text, links}) → {score, links[]} | null
  ├─ if detected → EmailMetadata.confirmation = { links }
  └─ Feed.ingest() raises FeedMetadata.pendingConfirmation = true
        → FeedRepository.saveMetadata projects pendingConfirmation into feeds:list
```

## 1. Detection

### `src/domain/confirmation.ts` (new, pure — no DOM)

```ts
detectConfirmation(input: {
  subject: string;
  text: string;            // plain-text rendition of the body
  links: { href: string; text: string }[];
}): { score: number; links: string[] } | null
```

- **Multilingual keyword lists** (FR/EN/DE/ES and extensible) for subject + body:
  `confirm`, `verify`, `activate`, `subscribe`, `confirmer`, `valider`,
  `activer`, `bestätigen`, `confirmar`, `verificar`, … (case/diacritic-insensitive
  matching).
- **Link scoring** by anchor text + URL path/query signals: `/confirm`, `/verify`,
  `/activate`, `/subscribe`, `/opt-in`, `token=`, `confirm=`, `?c=`, etc.
- **Combined score** = subject/body keyword signal + best link signal. Above a
  tuned `THRESHOLD` → return the ranked candidate links (top 3). Below → `null`.
- Only `http(s):` links are ever considered/returned (no `javascript:`/`data:`/
  `mailto:`).
- This module owns the business knowledge (keyword vocab, weights, threshold);
  it is unit-tested in isolation.

### `src/infrastructure/html-processor.ts` — `extractLinks`

```ts
extractLinks(content: string): { href: string; text: string }[]
```

- HTML: linkedom parse, collect `<a href>` + anchor text.
- Plain text: regex URL fallback (href = url, text = url).
- Infra owns DOM parsing; the domain receives plain data.

### `src/application/email-processor.ts` — wire-in

In `storeEmail`, before building `newEntry`:

```ts
const text = htmlToText(input.content);
const links = extractLinks(input.content);
const confirmation = detectConfirmation({
  subject: input.subject,
  text,
  links,
});
// → EmailMetadata.confirmation = confirmation ? { links: confirmation.links } : undefined
```

Computed once at reception. Dedup/ingest flow otherwise unchanged.

## 2. Data model (additive)

### `EmailMetadata` (`src/types/index.ts`)

```ts
confirmation?: { links: string[] }; // present ⇒ detected; links = ranked top-3
```

Presence powers the list badge and the detail section. Additive → pre-feature
emails have nothing (no retroactive false positives).

### `FeedMetadata` (`src/types/index.ts`)

```ts
pendingConfirmation?: boolean; // ≥1 unactioned confirmation email present
```

### `FeedListItem` (`src/types/index.ts`)

```ts
pendingConfirmation?: boolean; // projected from FeedMetadata for the dashboard
```

### Aggregate `Feed` (`src/domain/feed.aggregate.ts`)

- `ingest()` sets `pendingConfirmation = true` when the new `EmailMetadata` carries
  `confirmation`.
- `removeEmails()` recomputes the flag (false when no confirmation email remains).
- `dismissConfirmation()` sets it to false.
- read accessor `pendingConfirmation`.

### Persistence (`src/infrastructure/feed-repository.ts` + `feed-mapper.ts`)

- `FeedMetadata` round-trips `pendingConfirmation`.
- **Sync invariant extended**: `saveMetadata` projects `pendingConfirmation` into
  the `feeds:list` item (today only `save`/`saveConfig` upsert the list). This is
  the one metadata-derived field the list carries; it keeps the dashboard at a
  single KV read instead of N per-feed metadata reads.

## 3. Admin UI

### a) Detail view — dedicated section (`routes/admin/emails.tsx`, `GET /emails/:emailKey`)

Above the Rendered/Raw toggle, shown when `email.confirmation`:

- Heading "Confirm your subscription".
- Best-scored link as a **primary button**; remaining candidates as secondary
  links. URLs shown in clear text (transparency). `target="_blank" rel="noopener
noreferrer"`.

### b) Email list badge (`routes/admin/emails.tsx`, `GET /feeds/:feedId/emails`)

A "Confirmation" badge in the subject cell of rows where `email.confirmation`
exists, styled like the existing attachment indicator.

### c) Dashboard indicator (`routes/admin.tsx`, `GET /`)

A "Confirmation pending" pill on feeds whose `FeedListItem.pendingConfirmation` is
true (list + table views), read with zero extra KV reads. Links to the feed's
emails page.

### d) Feed emails-page banner (`routes/admin/emails.tsx`)

When `feedMetadata.pendingConfirmation`: a top banner "A confirmation email was
detected" linking to the latest confirmation email, plus a "Mark as confirmed"
button (dismiss).

### Post-creation redirect

`POST /admin/feeds/create` redirects to `/admin/feeds/:feedId/emails` (not the
dashboard) so the user lands where the banner appears once the (async) confirmation
email arrives.

## 4. Dismiss action

`POST /admin/feeds/:feedId/confirmation/dismiss`:

- load aggregate → `feed.dismissConfirmation()` → `repo.saveMetadata(feed)`
  (reprojects `pendingConfirmation:false` into `feeds:list`).
- JSON response for the banner's fetch (mirrors the existing sender-filter
  pattern); redirect fallback for no-JS.
- Protected by the existing admin auth + CSRF middleware.

"Dismiss" = "stop reminding me" (no real confirmation tracking without autoclick).
Deleting the confirmation email(s) also clears the flag via `removeEmails`.

## Security

- v1 performs **no outbound request** → no SSRF surface.
- Candidate `href`s filtered to `http(s):` only; never `javascript:`/`data:`.
- Output escaped via normal hono/jsx rendering.

## Testing (TDD)

- `confirmation.test.ts` (domain): multilingual scoring, threshold, link ranking,
  negative cases (normal newsletter doesn't trigger), plain-text body.
- `html-processor.test.ts`: `extractLinks` for HTML and plain text.
- `email-processor.test.ts`: confirmation email → `EmailMetadata.confirmation`
  populated + `pendingConfirmation` raised; dedup/ingest otherwise unchanged.
- `admin.test.ts` / emails tests: list badge, detail section, dashboard pill,
  banner, dismiss route (clears flag + reprojects into list).

Close green: `npx tsc --noEmit`, `npm test`, `npm run build`.

## Docs

- `README.md` + `INSTALL.md`: "Subscription confirmation surfacing" capability.
- `docs/index.html` (landing): feature card — a genuine differentiator vs
  kill-the-newsletter.
- `TODO.md`: check off `P1·M` "Subscription confirmation handling"; add a new
  `P2·M` "Confirmation on-detect action (none/autoclick/forward)" item capturing
  the deferred server options + SSRF/fallback notes.
