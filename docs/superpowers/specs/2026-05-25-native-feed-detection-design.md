# Detect a newsletter's native Atom/RSS/JSON feed — design

_Date: 2026-05-25 · Backlog item: TODO.md "Detect a newsletter's native Atom/RSS feed" (P2·S)_

## Goal

When an incoming newsletter email's HTML advertises its own syndication feed via
`<link rel="alternate" type="…">`, detect it and surface it to the admin:
"this newsletter already publishes a feed — you can subscribe to it directly."

A genuine differentiator: it is the top item on upstream kill-the-newsletter's
own TODO and is not built there. Per the user, detect **Atom, RSS, and JSON Feed**.

## Approach

Reuse the existing, proven pipeline — identical to the **confirmation-detection**
feature and the **per-sender unsubscribe** storage:

infra parses the HTML → a **pure domain detector** decides which links count →
the result rides into the aggregate via `IngestOptions` (like `unsub`) → the
aggregate stores it per-sender → admin surfaces it (detail + list badge +
dashboard pill + dismiss) → exposed read-only on the REST API.

Alternative considered and rejected: an ad-hoc detector living in infrastructure.
The "which MIME types are a feed" rule is business knowledge, so it belongs in
`domain/`, mirroring `domain/confirmation.ts`.

## Data model

```ts
// New value shape
type NativeFeed = { url: string; type: "rss" | "atom" | "json" };

// FeedMetadata (src/types/index.ts) — additive, like `unsubscribe` / `pendingConfirmation`
nativeFeeds?: Record<string, NativeFeed[]>; // key = senderKey (same scheme as `unsubscribe`)
nativeFeedDismissed?: boolean;              // dismiss: hides pill + badge, keeps the URLs

// FeedListItem (src/types/index.ts) — projected flag for the dashboard, like pendingConfirmation
hasNativeFeed?: boolean;
```

Update semantics (chosen by the user: "accumulation, but latest-per-sender"):

- Storage is **per sender**, keyed by the same `senderKey` used for `unsubscribe`
  (`input.senders[0] || iconDomain || input.from`).
- **Latest non-empty wins per sender**: the most recent email from a given sender
  that declares feeds overwrites _that sender's_ list; other senders are preserved.
  Mirrors how `ingest` updates `unsubscribe` only when an unsubscribe URL is present.
- The aggregate exposes `nativeFeeds(): NativeFeed[]` = the **union across senders,
  deduped by URL** (returns a copy).
- Projected flag `hasNativeFeed = nativeFeeds().length > 0 && !nativeFeedDismissed`.

Smart re-notify (avoid nagging on every email):

- On ingest, if a **previously-unseen URL** appears (not in the current union),
  clear `nativeFeedDismissed` (re-raise the notice).
- If ingestion only re-discovers already-known URLs, leave `nativeFeedDismissed`
  untouched, so a dismiss sticks until a genuinely new native feed shows up.

## Detection

**Infra — `src/infrastructure/html-processor.ts`**: new
`extractFeedLinks(content): { href: string; type: string }[]`.

- Parse `<link>` elements whose `rel` token-list contains `alternate` and that
  carry a `type` attribute (`link[rel~="alternate"][type]`).
- Return the raw `href` + `type` tuples; absolutize a relative `href` best-effort
  via the existing `toAbsolute` helper; http(s) only (drop others).
- Plain-text bodies have no `<link>` → returns `[]`.

**Domain — `src/domain/native-feed.ts`** (pure, no DOM/IO, mirrors `confirmation.ts`):
`detectNativeFeeds(links): NativeFeed[]`.

- Owns the recognized MIME → kind table (strict, the three canonical types only):
  - `application/atom+xml` → `"atom"`
  - `application/rss+xml` → `"rss"`
  - `application/feed+json` → `"json"`
- Ignores any other type (no `application/json` — too broad, would capture non-feeds).
- Dedupes by URL; preserves first-seen kind for a URL.

## Ingestion wiring

**`src/application/email-processor.ts`**: alongside the existing confirmation +
unsubscribe extraction, call `extractFeedLinks(input.content)` →
`detectNativeFeeds(...)`. When non-empty, pass into `feed.ingest` via
`IngestOptions`:

```ts
nativeFeeds?: { senderKey: string; feeds: NativeFeed[] };
```

`senderKey` is the same value already computed for `unsub`.

**`src/domain/feed.aggregate.ts`**:

- `ingest`: when `opts.nativeFeeds` is present, set
  `_metadata.nativeFeeds[senderKey] = feeds`; if any feed URL is new vs the
  pre-update union, set `_metadata.nativeFeedDismissed = false`.
- Getter `nativeFeeds(): NativeFeed[]` — union deduped by URL (copy).
- Getter `hasNativeFeed(): boolean` — `nativeFeeds().length > 0 && !dismissed`.
- `dismissNativeFeed(): void` — sets `nativeFeedDismissed = true` (lower-only,
  mirrors `dismissConfirmation`).
- `removeEmails` does **not** touch native feeds (the data is per-sender, not
  per-email; deleting emails should not drop a discovered native feed).

**`src/infrastructure/feed-mapper.ts`**: `toListItemDTO` gains a `hasNativeFeed`
parameter (like `pendingConfirmation`), projected into `FeedListItem`. The
repository passes `feed.hasNativeFeed()` when saving. `nativeFeeds` /
`nativeFeedDismissed` persist as part of `FeedMetadata` (stored directly in KV —
additive, no mapper change for the metadata blob itself).

## REST API

**`src/routes/api/schemas.ts`** — `FeedSchema` gains a read-only field:

```ts
nativeFeeds: z.array(z.object({
  url: z.string(),
  type: z.enum(["rss", "atom", "json"]),
})),
```

Populated from `feed.nativeFeeds()` in the feed-read handler so an API client can
choose which native feed to subscribe to. Read-only — not accepted on
`FeedCreate`/`FeedUpdate`.

## Admin UI

Mirror the confirmation surfaces (detail + badge + pill + dismiss).

- **Detail (per-feed view, `src/routes/admin/emails.tsx`)**: next to the existing
  `FeedFormats` "Subscribe" block (the **KTN feeds**), render a second group
  **"Native feeds"** when `nativeFeeds()` is non-empty. Each native feed is a
  copyable chip (type label RSS/Atom/JSON + copy + open-in-new-tab), reusing the
  existing copyable/chip styling. Net result: KTN feeds on one side, native feeds
  on the other, both copy-pasteable into a reader. Include a "dismiss" control
  (POST to the dismiss route) to clear the dashboard/list notice.
- **List badge (`src/routes/admin.tsx` feed row)**: a discreet badge when
  `hasNativeFeed`.
- **Dashboard pill**: `pill-native` (styled like `pill-confirmation`) on the
  dashboard feed list when `hasNativeFeed`.
- **Dismiss route**: `POST /admin/feeds/:feedId/native-feed/dismiss` → load
  aggregate → `feed.dismissNativeFeed()` → save → JSON ok. Client script wired
  like the existing `confirmation-dismiss` (in `src/scripts/client/`).
- **Styles**: add `.native-feeds` group + `.pill-native` + badge rules in
  `src/styles/components.css`, matching the format-chip / confirmation styling.

## Out of scope (v1)

- No change to the **public XML/JSON feed output** (user decision: native feeds
  live in admin + REST, not in the rendered feeds).
- No anchor-text heuristics ("Subscribe via RSS" links) — `<link rel=alternate>`
  only, to keep false positives near zero.

## Testing

- `src/domain/native-feed.test.ts` — MIME mapping, dedupe, ignores unknown types.
- `src/infrastructure/html-processor.test.ts` — `extractFeedLinks`: rel/type
  parsing, relative-href absolutization, http(s)-only, plain-text → `[]`.
- `src/domain/feed.aggregate.test.ts` — ingest per-sender latest-wins, union
  getter, re-notify on new URL, dismiss lower-only, removeEmails leaves it intact.
- `src/application/email-processor.test.ts` — end-to-end: an email with a
  `<link rel=alternate>` populates `nativeFeeds`; one without leaves it alone.
- `src/infrastructure/feed-mapper.test.ts` / repository — `hasNativeFeed`
  projection into `feeds:list`.
- `src/routes/admin.test.ts` — detail "native-feeds" group, list badge, dashboard
  `pill-native`, dismiss route clears the flag.
- REST API test — `FeedSchema.nativeFeeds` present in the feed-read response.

End green: `npx tsc --noEmit`, `npm test`, `npm run build`.

## Docs

- `README.md` / `INSTALL.md` — mention native-feed detection.
- `docs/index.html` (marketing landing) — add a feature card (it's a
  differentiator we ship before upstream).
- `CLAUDE.md` — add `domain/native-feed.ts` to the source layout; note the new
  `FeedMetadata.nativeFeeds` / `nativeFeedDismissed` fields.
