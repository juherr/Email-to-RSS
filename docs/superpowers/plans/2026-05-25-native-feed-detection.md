# Native Atom/RSS/JSON Feed Detection — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect a newsletter's own syndication feed (Atom/RSS/JSON) advertised via `<link rel="alternate">` in incoming email HTML, store it per-sender on the feed, and surface it in the admin UI and REST API so the user can subscribe to it directly.

**Architecture:** Mirror the existing confirmation-detection + per-sender-unsubscribe pipeline. Infrastructure (`html-processor`) parses the HTML into `{href,type}` tuples; a pure domain detector (`domain/native-feed.ts`) decides which MIME types count and dedupes; the result rides into the `Feed` aggregate via `IngestOptions` (like `unsub`), stored per-sender with latest-non-empty-wins. The aggregate exposes a deduped union + a `hasNativeFeed` flag projected into `feeds:list`. Admin surfaces it (copyable chips + dismissable banner + dashboard pill); the REST `FeedSchema` exposes it read-only.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono, hono/jsx, linkedom, Zod/`@hono/zod-openapi`, Vitest.

**Conventions:** Work test-first (TDD). End every task green. Final gate for the whole plan: `npx tsc --noEmit`, `npm test`, `npm run build`. Run a single test file with `npx vitest run <path>`.

---

### Task 1: Domain detector + value shape (`domain/native-feed.ts`)

**Files:**

- Modify: `src/types/index.ts` (add `NativeFeed` interface near `EmailMetadata`, ~line 73)
- Create: `src/domain/native-feed.ts`
- Test: `src/domain/native-feed.test.ts`

- [ ] **Step 1: Add the `NativeFeed` type to `src/types/index.ts`**

Insert this interface just above `// Email metadata interface (summary info for listing)` (currently ~line 72):

```ts
// A syndication feed a newsletter advertises about itself (via
// <link rel="alternate">), as opposed to the KTN-generated feed.
export interface NativeFeed {
  url: string;
  type: "rss" | "atom" | "json";
}
```

- [ ] **Step 2: Write the failing test**

Create `src/domain/native-feed.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectNativeFeeds, unionNativeFeeds } from "./native-feed";

describe("detectNativeFeeds", () => {
  it("maps the three canonical MIME types to kinds", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/atom", type: "application/atom+xml" },
        { href: "https://x.com/rss", type: "application/rss+xml" },
        { href: "https://x.com/json", type: "application/feed+json" },
      ]),
    ).toEqual([
      { url: "https://x.com/atom", type: "atom" },
      { url: "https://x.com/rss", type: "rss" },
      { url: "https://x.com/json", type: "json" },
    ]);
  });

  it("ignores unknown MIME types (application/json, text/html)", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/api", type: "application/json" },
        { href: "https://x.com/", type: "text/html" },
      ]),
    ).toEqual([]);
  });

  it("strips MIME parameters and is case-insensitive", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/f", type: "Application/RSS+XML; charset=utf-8" },
      ]),
    ).toEqual([{ url: "https://x.com/f", type: "rss" }]);
  });

  it("dedupes by URL (first kind wins)", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/f", type: "application/rss+xml" },
        { href: "https://x.com/f", type: "application/atom+xml" },
      ]),
    ).toEqual([{ url: "https://x.com/f", type: "rss" }]);
  });
});

describe("unionNativeFeeds", () => {
  it("returns [] for undefined", () => {
    expect(unionNativeFeeds(undefined)).toEqual([]);
  });

  it("unions across senders, deduping by URL", () => {
    expect(
      unionNativeFeeds({
        "a@x.com": [{ url: "https://x.com/rss", type: "rss" }],
        "b@y.com": [
          { url: "https://x.com/rss", type: "rss" },
          { url: "https://y.com/atom", type: "atom" },
        ],
      }),
    ).toEqual([
      { url: "https://x.com/rss", type: "rss" },
      { url: "https://y.com/atom", type: "atom" },
    ]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/domain/native-feed.test.ts`
Expected: FAIL — cannot resolve `./native-feed`.

- [ ] **Step 4: Implement `src/domain/native-feed.ts`**

```ts
/**
 * Pure detection of a newsletter's own syndication feed. No DOM, no I/O — it
 * receives already-extracted <link> tuples (infra parses the HTML) and decides
 * which ones are real feeds. This module owns the business knowledge: the strict
 * set of recognized feed MIME types.
 */
import { NativeFeed } from "../types";

// MIME type → feed kind. Strict: only the three canonical syndication types.
// `application/json` is deliberately excluded — too broad, captures non-feeds.
const MIME_TO_KIND: Record<string, NativeFeed["type"]> = {
  "application/atom+xml": "atom",
  "application/rss+xml": "rss",
  "application/feed+json": "json",
};

// Drop MIME parameters ("; charset=…"), trim, lowercase.
function normalizeMime(type: string): string {
  return type.split(";")[0].trim().toLowerCase();
}

/** Map raw <link> tuples to recognized native feeds, deduped by URL. */
export function detectNativeFeeds(
  links: { href: string; type: string }[],
): NativeFeed[] {
  const out: NativeFeed[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const kind = MIME_TO_KIND[normalizeMime(link.type)];
    if (!kind) continue;
    const url = link.href.trim();
    if (!url || seen.has(url)) continue;
    seen.add(url);
    out.push({ url, type: kind });
  }
  return out;
}

/** Flatten per-sender native feeds into one list, deduped by URL (first wins). */
export function unionNativeFeeds(
  bySender: Record<string, NativeFeed[]> | undefined,
): NativeFeed[] {
  if (!bySender) return [];
  const out: NativeFeed[] = [];
  const seen = new Set<string>();
  for (const feeds of Object.values(bySender)) {
    for (const feed of feeds) {
      if (seen.has(feed.url)) continue;
      seen.add(feed.url);
      out.push({ ...feed });
    }
  }
  return out;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/domain/native-feed.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/domain/native-feed.ts src/domain/native-feed.test.ts
git commit -m "feat(domain): add native-feed detector (Atom/RSS/JSON)"
```

---

### Task 2: Extract feed links from HTML (`extractFeedLinks`)

**Files:**

- Modify: `src/infrastructure/html-processor.ts` (add export near `extractLinks`, ~line 70)
- Test: `src/infrastructure/html-processor.test.ts` (append a `describe` block)

Context: `isPlainText(content)` (returns true when the content has no HTML tags) and the module-private `toAbsolute(value, base)` (returns an absolute URL for a relative value, or `null` for already-absolute / non-rewritable values) already exist in this file. `extractLinks` (anchor extraction) is the sibling pattern to mirror.

- [ ] **Step 1: Write the failing test**

Append to `src/infrastructure/html-processor.test.ts` (add `extractFeedLinks` to the existing import from `./html-processor`):

```ts
describe("extractFeedLinks", () => {
  it("extracts rel=alternate links that carry a type", () => {
    const html = `<html><head>
      <link rel="alternate" type="application/rss+xml" href="https://blog.example.com/feed.xml">
      <link rel="alternate" type="application/atom+xml" href="https://blog.example.com/atom.xml">
    </head><body>hi</body></html>`;
    expect(extractFeedLinks(html)).toEqual([
      {
        href: "https://blog.example.com/feed.xml",
        type: "application/rss+xml",
      },
      {
        href: "https://blog.example.com/atom.xml",
        type: "application/atom+xml",
      },
    ]);
  });

  it("ignores non-alternate rels and links without a type", () => {
    const html = `<head>
      <link rel="stylesheet" type="text/css" href="https://x.com/a.css">
      <link rel="alternate" href="https://x.com/notype">
    </head>`;
    expect(extractFeedLinks(html)).toEqual([]);
  });

  it("absolutizes a relative href against the base", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`;
    expect(extractFeedLinks(html, "https://blog.example.com")).toEqual([
      {
        href: "https://blog.example.com/feed.xml",
        type: "application/rss+xml",
      },
    ]);
  });

  it("drops a relative href when no base is given", () => {
    const html = `<head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head>`;
    expect(extractFeedLinks(html)).toEqual([]);
  });

  it("returns [] for plain-text bodies", () => {
    expect(extractFeedLinks("just text https://x.com/feed")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/infrastructure/html-processor.test.ts -t extractFeedLinks`
Expected: FAIL — `extractFeedLinks` is not exported.

- [ ] **Step 3: Implement `extractFeedLinks`**

Add directly after `extractLinks` (after its closing `}`, ~line 70) in `src/infrastructure/html-processor.ts`:

```ts
// Collect a newsletter's self-advertised feed declarations:
// <link rel="alternate" type="application/(atom|rss)+xml|feed+json" href="…">.
// Returns raw href+type tuples; the domain decides which MIME types are feeds.
// Relative hrefs are absolutized against the sender base (best-effort); only
// http(s) URLs survive. Plain-text bodies have no <link> → [].
export function extractFeedLinks(
  content: string,
  base = "",
): { href: string; type: string }[] {
  if (!content || isPlainText(content)) return [];

  const { document } = parseHTML(content);
  const links: { href: string; type: string }[] = [];
  document
    .querySelectorAll('link[rel~="alternate"][type]')
    .forEach((el: Element) => {
      const type = (el.getAttribute("type") ?? "").trim();
      const rawHref = (el.getAttribute("href") ?? "").trim();
      if (!type || !rawHref) return;
      const href = /^https?:\/\//i.test(rawHref)
        ? rawHref
        : (toAbsolute(rawHref, base) ?? "");
      if (!/^https?:\/\//i.test(href)) return;
      links.push({ href, type });
    });
  return links;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/infrastructure/html-processor.test.ts -t extractFeedLinks`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/html-processor.ts src/infrastructure/html-processor.test.ts
git commit -m "feat(infra): extract rel=alternate feed links from email HTML"
```

---

### Task 3: Aggregate storage, getters, dismiss

**Files:**

- Modify: `src/types/index.ts` (add fields to `FeedMetadata` ~line 60 and `FeedListItem` ~line 99)
- Modify: `src/domain/feed.aggregate.ts` (`IngestOptions` ~line 55; imports ~line 1; getters near `pendingConfirmation` ~line 162; `ingest` ~line 254; new `dismissNativeFeed`)
- Test: `src/domain/feed.aggregate.test.ts` (append a `describe` block)

- [ ] **Step 1: Add the metadata + list-item fields to `src/types/index.ts`**

In `interface FeedMetadata` (after the `pendingConfirmation?` field, ~line 70), add:

```ts
  // Native syndication feeds (Atom/RSS/JSON) senders advertised via
  // <link rel="alternate">, keyed by sender. Latest non-empty per sender wins.
  nativeFeeds?: Record<string, NativeFeed[]>;
  // True when the admin dismissed the native-feed notice; suppresses the
  // dashboard pill while the URLs stay available in the feed detail view.
  nativeFeedDismissed?: boolean;
```

In `interface FeedListItem` (after `pendingConfirmation?`, ~line 99), add:

```ts
  hasNativeFeed?: boolean; // Projected from FeedMetadata for the dashboard pill
```

- [ ] **Step 2: Write the failing test**

Append to `src/domain/feed.aggregate.test.ts`:

```ts
describe("Feed native feeds", () => {
  const nf = (
    senderKey: string,
    url: string,
    type: "rss" | "atom" | "json",
  ) => ({
    maxBytes: 1_000_000_000,
    nativeFeeds: { senderKey, feeds: [{ url, type }] },
  });

  it("stores native feeds and raises the flag on ingest", () => {
    const feed = Feed.create(FID, createInput(), { mailboxId: MBOX });
    feed.ingest(entry(), nf("a@x.com", "https://x.com/rss", "rss"));
    expect(feed.nativeFeeds()).toEqual([
      { url: "https://x.com/rss", type: "rss" },
    ]);
    expect(feed.hasNativeFeed()).toBe(true);
  });

  it("latest non-empty wins per sender; other senders preserved", () => {
    const feed = Feed.create(FID, createInput(), { mailboxId: MBOX });
    feed.ingest(
      entry({ key: "k1" }),
      nf("a@x.com", "https://x.com/old", "rss"),
    );
    feed.ingest(
      entry({ key: "k2" }),
      nf("b@y.com", "https://y.com/atom", "atom"),
    );
    feed.ingest(
      entry({ key: "k3" }),
      nf("a@x.com", "https://x.com/new", "rss"),
    );
    expect(feed.nativeFeeds()).toEqual([
      { url: "https://x.com/new", type: "rss" },
      { url: "https://y.com/atom", type: "atom" },
    ]);
  });

  it("dismiss hides the notice but keeps URLs; only a new URL re-raises", () => {
    const feed = Feed.create(FID, createInput(), { mailboxId: MBOX });
    feed.ingest(
      entry({ key: "k1" }),
      nf("a@x.com", "https://x.com/rss", "rss"),
    );
    feed.dismissNativeFeed();
    expect(feed.hasNativeFeed()).toBe(false);
    expect(feed.nativeFeeds()).toHaveLength(1);
    feed.ingest(
      entry({ key: "k2" }),
      nf("a@x.com", "https://x.com/rss", "rss"),
    );
    expect(feed.hasNativeFeed()).toBe(false); // same URL → stays dismissed
    feed.ingest(
      entry({ key: "k3" }),
      nf("a@x.com", "https://x.com/rss2", "rss"),
    );
    expect(feed.hasNativeFeed()).toBe(true); // new URL → re-raise
  });

  it("removeEmails leaves native feeds intact", () => {
    const feed = Feed.create(FID, createInput(), { mailboxId: MBOX });
    feed.ingest(
      entry({ key: "k1" }),
      nf("a@x.com", "https://x.com/rss", "rss"),
    );
    feed.removeEmails(["k1"]);
    expect(feed.nativeFeeds()).toEqual([
      { url: "https://x.com/rss", type: "rss" },
    ]);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/domain/feed.aggregate.test.ts -t "native feeds"`
Expected: FAIL — `feed.nativeFeeds`/`hasNativeFeed`/`dismissNativeFeed` are not functions.

- [ ] **Step 4: Implement the aggregate changes in `src/domain/feed.aggregate.ts`**

(a) Extend the imports on line 1:

```ts
import { FeedMetadata, EmailMetadata, NativeFeed } from "../types";
```

and add below the existing domain imports (after line 8):

```ts
import { unionNativeFeeds } from "./native-feed";
```

(b) Add a field to `IngestOptions` (inside the interface, after the `unsub?` line ~line 59):

```ts
  /** Native syndication feeds the sender advertised, keyed by sender. */
  nativeFeeds?: { senderKey: string; feeds: NativeFeed[] };
```

(c) Add getters right after the `pendingConfirmation` getter (after its closing `}`, ~line 165):

```ts
  /** Discovered native feeds (Atom/RSS/JSON), union across senders, deduped. */
  nativeFeeds(): NativeFeed[] {
    return unionNativeFeeds(this._metadata.nativeFeeds);
  }

  /** True when a native feed was discovered and the notice was not dismissed. */
  hasNativeFeed(): boolean {
    return (
      this.nativeFeeds().length > 0 && !this._metadata.nativeFeedDismissed
    );
  }
```

(d) In `ingest`, after the `if (entry.confirmation) { … }` block (~line 272), add:

```ts
if (opts.nativeFeeds && opts.nativeFeeds.feeds.length > 0) {
  const known = new Set(this.nativeFeeds().map((f) => f.url));
  this._metadata.nativeFeeds = {
    ...(this._metadata.nativeFeeds ?? {}),
    [opts.nativeFeeds.senderKey]: opts.nativeFeeds.feeds,
  };
  // Re-raise the notice only when a genuinely new URL appears, so a dismiss
  // survives the same feed being re-advertised on every subsequent email.
  if (opts.nativeFeeds.feeds.some((f) => !known.has(f.url))) {
    this._metadata.nativeFeedDismissed = false;
  }
}
```

(e) Add the dismiss method right after `dismissConfirmation()` (~line 322):

```ts
  /** Mark the native-feed notice as handled — "stop reminding me". */
  dismissNativeFeed(): void {
    this._metadata.nativeFeedDismissed = true;
  }
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/domain/feed.aggregate.test.ts -t "native feeds"`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/domain/feed.aggregate.ts src/domain/feed.aggregate.test.ts
git commit -m "feat(domain): store native feeds per-sender on the Feed aggregate"
```

---

### Task 4: Project `hasNativeFeed` into `feeds:list`

**Files:**

- Modify: `src/infrastructure/feed-mapper.ts` (`toListItemDTO` ~line 48)
- Modify: `src/infrastructure/feed-repository.ts` (3 `toListItemDTO` call sites: lines 91, 107, 121)
- Test: `src/infrastructure/feed-mapper.test.ts` (update existing projection test + add one)

- [ ] **Step 1: Update the failing test**

In `src/infrastructure/feed-mapper.test.ts`, update the existing "projects the feeds:list item" expectation (the `expect(item).toEqual({…})` block, ~line 40) to include the new field:

```ts
expect(item).toEqual({
  id: "a.b.42",
  title: "News",
  description: "desc",
  mailbox_id: "a.b.42",
  expires_at: 3000,
  pendingConfirmation: false,
  hasNativeFeed: false,
});
```

Then append a new test inside the `describe("feed-mapper", …)` block:

```ts
it("projects hasNativeFeed when passed", () => {
  const item = toListItemDTO(
    FeedId.unchecked("a.b.42"),
    fromConfigDTO(fullConfig),
    true,
    true,
  );
  expect(item.pendingConfirmation).toBe(true);
  expect(item.hasNativeFeed).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/infrastructure/feed-mapper.test.ts`
Expected: FAIL — `hasNativeFeed` missing from the projected object / unknown 4th arg.

- [ ] **Step 3: Implement the mapper + repository changes**

In `src/infrastructure/feed-mapper.ts`, change `toListItemDTO`:

```ts
export function toListItemDTO(
  id: FeedId,
  state: FeedState,
  pendingConfirmation = false,
  hasNativeFeed = false,
): FeedListItem {
  return {
    id: id.value,
    title: state.title,
    description: state.description,
    mailbox_id: state.mailboxId,
    expires_at: state.expiresAt,
    pendingConfirmation,
    hasNativeFeed,
  };
}
```

In `src/infrastructure/feed-repository.ts`, update all three `toListItemDTO(...)` calls (lines 91, 107, 121) from:

```ts
        toListItemDTO(feed.id, feed.state(), feed.pendingConfirmation),
```

to:

```ts
        toListItemDTO(
          feed.id,
          feed.state(),
          feed.pendingConfirmation,
          feed.hasNativeFeed(),
        ),
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/infrastructure/feed-mapper.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/feed-mapper.ts src/infrastructure/feed-repository.ts src/infrastructure/feed-mapper.test.ts
git commit -m "feat(infra): project hasNativeFeed into feeds:list"
```

---

### Task 5: Wire detection into ingestion

**Files:**

- Modify: `src/application/email-processor.ts` (imports ~line 10-13; detection ~after line 194; ingest opts ~line 240-256)
- Test: `src/application/email-processor.test.ts` (append a `describe`/`it`)

Context: `extractLinks`/`htmlToText` are already imported from `../infrastructure/html-processor`; `detectConfirmation` from `../domain/confirmation`. The ingest call (~line 252) builds `opts` with `iconDomain` and `unsub`, whose `senderKey` is `input.senders[0] || iconDomain || input.from`.

- [ ] **Step 1: Write the failing test**

First inspect an existing storing test in `src/application/email-processor.test.ts` to reuse its harness (how it calls `processEmail`/`storeEmail`, builds the env, and reads `repo.getMetadata`). Append a test mirroring that harness:

```ts
describe("native feed detection on ingest", () => {
  it("stores a native feed when the email advertises one", async () => {
    const env = createMockEnv() as unknown as Env;
    const repo = FeedRepository.from(env);
    // Arrange a feed + inbound index the same way the other ingest tests do.
    const { feedId, mailbox } = await seedFeed(env); // reuse the file's helper
    const html =
      '<html><head><link rel="alternate" type="application/rss+xml" ' +
      'href="https://blog.example.com/feed.xml"></head><body>hello</body></html>';

    await processEmail(
      buildInput({
        to: `${mailbox}@example.com`,
        from: "news@blog.example.com",
        content: html,
      }),
      env,
      noopScheduler,
    );

    const metadata = await repo.getMetadata(feedId);
    expect(metadata?.nativeFeeds).toBeDefined();
    expect(Object.values(metadata!.nativeFeeds!).flat()).toEqual([
      { url: "https://blog.example.com/feed.xml", type: "rss" },
    ]);
  });

  it("leaves native feeds unset for an email without one", async () => {
    const env = createMockEnv() as unknown as Env;
    const repo = FeedRepository.from(env);
    const { feedId, mailbox } = await seedFeed(env);

    await processEmail(
      buildInput({
        to: `${mailbox}@example.com`,
        from: "news@blog.example.com",
        content: "<p>no feed here</p>",
      }),
      env,
      noopScheduler,
    );

    const metadata = await repo.getMetadata(feedId);
    expect(metadata?.nativeFeeds).toBeUndefined();
  });
});
```

NOTE for the implementer: `seedFeed`, `buildInput`, `noopScheduler`, and the exact `processEmail` entrypoint are placeholders for whatever the existing tests in this file already use — match the file's established helpers and imports rather than inventing new ones. The two assertions (a `<link rel=alternate>` email populates `nativeFeeds`; a plain email leaves it `undefined`) are the contract.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/application/email-processor.test.ts -t "native feed detection"`
Expected: FAIL — `metadata.nativeFeeds` is undefined in the positive case.

- [ ] **Step 3: Implement the wiring in `src/application/email-processor.ts`**

(a) Extend the html-processor import (~line 10) to include `extractFeedLinks`:

```ts
import {
  extractInlineCids, // keep whatever is already imported here
  extractLinks,
  extractFeedLinks,
  htmlToText,
} from "../infrastructure/html-processor";
```

(adjust to preserve the file's existing named imports from this module).

(b) Add the domain import next to the confirmation import (~line 13):

```ts
import { detectNativeFeeds } from "../domain/native-feed";
```

(c) Right after the `confirmationLinks` detection block (~line 194), add:

```ts
const nativeFeedList = detectNativeFeeds(
  extractFeedLinks(input.content, iconBase(input.from)),
);
```

where `iconBase` is a tiny local helper — add it as a module-level function near the top of the file (after imports):

```ts
// Best-effort site base for absolutizing a sender's relative feed link.
function iconBase(from: string): string {
  const at = from.lastIndexOf("@");
  const domain = at >= 0 ? from.slice(at + 1).trim() : "";
  return domain ? `https://${domain}` : "";
}
```

(d) In the ingest block (~line 252), reuse one `senderKey`. Replace the existing `unsub` construction (lines ~242-247) and the `feed.ingest(...)` opts so both share `senderKey`:

```ts
const iconDomain = extractEmailDomain(input.from);
const senderKey = input.senders[0] || iconDomain || input.from;
const unsubUrl = parseOneClickUnsubscribe(input.headers ?? {});
const unsub = unsubUrl ? { senderKey, url: unsubUrl } : undefined;

const maxBytes = parseInt(env.FEED_MAX_SIZE_BYTES ?? "", 10) || FEED_MAX_BYTES;

const { dropped } = feed.ingest(newEntry, {
  maxBytes,
  iconDomain: iconDomain ?? undefined,
  unsub,
  ...(nativeFeedList.length > 0
    ? { nativeFeeds: { senderKey, feeds: nativeFeedList } }
    : {}),
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/application/email-processor.test.ts -t "native feed detection"`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the whole processor suite to catch regressions**

Run: `npx vitest run src/application/email-processor.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/application/email-processor.ts src/application/email-processor.test.ts
git commit -m "feat(app): detect native feeds during email ingestion"
```

---

### Task 6: Expose native feeds on the REST API

**Files:**

- Modify: `src/routes/api/schemas.ts` (`FeedSchema` ~line 86-103)
- Modify: `src/routes/api/index.ts` (imports ~line 27; `toFeed` ~line 49-71; 3 call sites lines 159, 186, 231)
- Test: existing API test file (search for the feed-read test, e.g. `src/routes/api.test.ts` or similar)

- [ ] **Step 1: Write the failing test**

Locate the API test that reads a single feed (grep for `rssUrl` or `/v1/feeds/` GET in the test dirs). Add an assertion that the read response includes `nativeFeeds`. Minimal addition to an existing "get a feed" test:

```ts
const body = (await res.json()) as { nativeFeeds: unknown };
expect(Array.isArray(body.nativeFeeds)).toBe(true);
```

If a test ingests an email with a `<link rel="alternate" type="application/rss+xml" href="https://blog.example.com/feed.xml">` before reading the feed, assert:

```ts
expect(body.nativeFeeds).toEqual([
  { url: "https://blog.example.com/feed.xml", type: "rss" },
]);
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run <the-api-test-file>`
Expected: FAIL — `nativeFeeds` missing from the response / not in schema.

- [ ] **Step 3: Add the schema field**

In `src/routes/api/schemas.ts`, inside `FeedSchema.object({...})`, after `atomUrl: z.string(),` (line 101) add:

```ts
    nativeFeeds: z.array(
      z.object({
        url: z.string(),
        type: z.enum(["rss", "atom", "json"]),
      }),
    ),
```

- [ ] **Step 4: Populate it in `toFeed` and the call sites**

In `src/routes/api/index.ts`, add imports (near line 27 and the FeedRepository/utils imports):

```ts
import { NativeFeed } from "../../types";
import { unionNativeFeeds } from "../../domain/native-feed";
```

Change `toFeed` (line 49) to accept and return native feeds:

```ts
function toFeed(
  id: string,
  config: FeedConfig,
  emailCount: number,
  env: Env,
  nativeFeeds: NativeFeed[],
): z.infer<typeof FeedSchema> {
  return {
    id,
    title: config.title,
    description: config.description,
    language: config.language,
    allowedSenders: config.allowed_senders ?? [],
    blockedSenders: config.blocked_senders ?? [],
    senderInTitle: config.sender_in_title ?? false,
    createdAt: config.created_at,
    updatedAt: config.updated_at,
    expiresAt: config.expires_at,
    emailCount,
    emailAddress: feedEmailAddress(config.mailbox_id, env),
    rssUrl: feedRssUrl(id, env),
    atomUrl: feedAtomUrl(id, env),
    nativeFeeds,
  };
}
```

Update the three call sites:

- Create handler (line 159): a brand-new feed has none →

```ts
return c.json(toFeed(feedId, config, 0, env, []), 201);
```

- Get handler (line 186):

```ts
return c.json(
  toFeed(
    feedId,
    config,
    metadata?.emails.length ?? 0,
    env,
    unionNativeFeeds(metadata?.nativeFeeds),
  ),
  200,
);
```

- Patch handler (line 231):

```ts
return c.json(
  toFeed(
    feedId,
    result.config,
    metadata?.emails.length ?? 0,
    env,
    unionNativeFeeds(metadata?.nativeFeeds),
  ),
  200,
);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run <the-api-test-file>`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/routes/api/schemas.ts src/routes/api/index.ts <the-api-test-file>
git commit -m "feat(api): expose nativeFeeds on the REST Feed schema (read-only)"
```

---

### Task 7: Admin UI components (`NativeFeeds` group + `NativeFeedPill`)

**Files:**

- Modify: `src/routes/admin/ui.tsx` (add `NativeFeeds` after `FeedFormats` ~line 255; reuses existing `CopyIcon`/`CheckIcon`/`OpenIcon`)
- Modify: `src/routes/admin.tsx` (add `NativeFeedPill` near `ConfirmationPill` ~line 226; render it ~line 639; import `NativeFeeds` is not needed here)
- Test: `src/routes/admin.test.ts` (append assertions)

- [ ] **Step 1: Write the failing test**

Append to `src/routes/admin.test.ts` (mirror the existing confirmation pill test around line 1298). One test here (the detail-group test lives in Task 8, where the detail page is wired so it can pass):

```ts
it("dashboard shows pill-native for feeds with hasNativeFeed", async () => {
  const env = createMockEnv() as unknown as Env;
  const feedId = FeedId.generate();
  const mailboxId = MailboxId.unchecked("native.pill.08");
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    feedId,
    { title: "N", language: "en", allowedSenders: [], blockedSenders: [] },
    { mailboxId },
  );
  feed.ingest(
    { key: "k1", subject: "s", receivedAt: 1, size: 10 },
    {
      maxBytes: 1e9,
      nativeFeeds: {
        senderKey: "a@x.com",
        feeds: [{ url: "https://x.com/rss", type: "rss" }],
      },
    },
  );
  await repo.save(feed);

  const res = await request(`/admin`, {}, env);
  const body = await res.text();
  expect(body).toContain("pill-native");
});
```

Match the file's actual `request(...)` helper signature and existing imports (`FeedId`, `MailboxId`, `Feed`, `FeedRepository`, `createMockEnv`) — they are already used by the confirmation tests in this file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/routes/admin.test.ts -t "pill-native"`
Expected: FAIL — no `pill-native` in the dashboard HTML.

- [ ] **Step 3: Add the `NativeFeeds` component to `src/routes/admin/ui.tsx`**

Add the `NativeFeed` type import at the top of `ui.tsx` (alongside the existing `Env`/`FeedFormat` type imports):

```ts
import type { NativeFeed } from "../../types";
```

Then, immediately after the `FeedFormats` component (after its closing `);`, ~line 255), add:

```tsx
const NATIVE_LABELS: Record<NativeFeed["type"], string> = {
  rss: "RSS",
  atom: "Atom",
  json: "JSON",
};

const NativeFeedChip = ({ feed }: { feed: NativeFeed }) => {
  const label = NATIVE_LABELS[feed.type];
  return (
    <div class="format-chip" data-format={feed.type}>
      <span class="format-chip-label">{label}</span>
      <span class="format-chip-actions">
        <span class="copyable copyable-chip">
          <span
            class="copyable-content"
            title={`Copy native ${label} feed URL`}
            aria-label={`Copy native ${label} feed URL`}
          >
            <span class="copyable-value" data-copy={feed.url} hidden></span>
            <span class="copy-icon-container">
              <CopyIcon />
              <CheckIcon />
            </span>
          </span>
        </span>
        <a
          class="chip-action"
          href={feed.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open native ${label} feed in a new tab`}
          aria-label={`Open native ${label} feed in a new tab`}
        >
          <OpenIcon />
        </a>
      </span>
    </div>
  );
};

export const NativeFeeds = ({ feeds }: { feeds: NativeFeed[] }) => {
  if (feeds.length === 0) return null;
  return (
    <div class="feed-formats native-feeds">
      <span class="feed-formats-label">Native feeds</span>
      <div class="feed-formats-chips">
        {feeds.map((feed) => (
          <NativeFeedChip feed={feed} />
        ))}
      </div>
    </div>
  );
};
```

- [ ] **Step 4: Add `NativeFeedPill` to `src/routes/admin.tsx`**

After `ConfirmationPill` (after its closing `);`, ~line 230) add:

```tsx
const NativeFeedPill = ({ feedId }: { feedId: string }) => (
  <a class="pill pill-native" href={`/admin/feeds/${feedId}/emails`}>
    Native feed available
  </a>
);
```

Render it next to the confirmation pill (~line 639-641), so the block reads:

```tsx
{
  feed.pendingConfirmation && <ConfirmationPill feedId={feed.id} />;
}
{
  feed.hasNativeFeed && <NativeFeedPill feedId={feed.id} />;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/routes/admin.test.ts -t "pill-native"`
Expected: PASS. (The `NativeFeeds` component is now exported and used by Task 8; nothing here renders it yet, which is fine — this task ends green.)

- [ ] **Step 6: Commit**

```bash
git add src/routes/admin/ui.tsx src/routes/admin.tsx src/routes/admin.test.ts
git commit -m "feat(admin): native feed chips + dashboard pill"
```

---

### Task 8: Feed detail page — render group + dismissable banner + route + client

**Files:**

- Modify: `src/routes/admin/emails.tsx` (detail handler ~line 137; render after `FeedFormats` ~line 166; banner after confirmation banner ~line 186; dismiss route after line 733; import `NativeFeeds` + `unionNativeFeeds`)
- Modify: `src/scripts/client/emails-page.ts` (append a dismiss handler after line 636)
- Test: `src/routes/admin.test.ts` (the detail test from Task 7 + a dismiss-route test)

- [ ] **Step 1: Add the detail-group test and the dismiss-route test**

Append both to `src/routes/admin.test.ts` (mirror the confirmation detail/dismiss tests ~line 1137 / ~line 1234):

```ts
it("feed detail shows a native-feeds group when a native feed was detected", async () => {
  const env = createMockEnv() as unknown as Env;
  const feedId = FeedId.generate();
  const mailboxId = MailboxId.unchecked("native.detail.07");
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    feedId,
    { title: "N", language: "en", allowedSenders: [], blockedSenders: [] },
    { mailboxId },
  );
  feed.ingest(
    { key: "k1", subject: "s", receivedAt: 1, size: 10 },
    {
      maxBytes: 1e9,
      nativeFeeds: {
        senderKey: "a@x.com",
        feeds: [{ url: "https://blog.example.com/feed.xml", type: "rss" }],
      },
    },
  );
  await repo.save(feed);

  const res = await request(`/admin/feeds/${feedId.value}/emails`, {}, env);
  const body = await res.text();
  expect(body).toContain("native-feeds");
  expect(body).toContain("https://blog.example.com/feed.xml");
});

it("native-feed dismiss route clears the flag", async () => {
  const env = createMockEnv() as unknown as Env;
  const feedId = FeedId.generate();
  const mailboxId = MailboxId.unchecked("native.dismiss.09");
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    feedId,
    { title: "N", language: "en", allowedSenders: [], blockedSenders: [] },
    { mailboxId },
  );
  feed.ingest(
    { key: "k1", subject: "s", receivedAt: 1, size: 10 },
    {
      maxBytes: 1e9,
      nativeFeeds: {
        senderKey: "a@x.com",
        feeds: [{ url: "https://x.com/rss", type: "rss" }],
      },
    },
  );
  await repo.save(feed);

  const res = await request(
    `/admin/feeds/${feedId.value}/native-feed/dismiss`,
    { method: "POST", headers: { "Content-Type": "application/json" } },
    env,
  );
  expect(res.status).toBe(200);
  const reloaded = await repo.load(feedId);
  expect(reloaded!.hasNativeFeed()).toBe(false);
  expect(reloaded!.nativeFeeds()).toHaveLength(1); // URLs preserved
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run src/routes/admin.test.ts -t "native"`
Expected: FAIL — the detail `native-feeds` group is absent and the dismiss route 404s.

- [ ] **Step 3: Render the group + banner in `src/routes/admin/emails.tsx`**

(a) Extend the import from `./ui` (line ~9) to include `NativeFeeds`, and add the domain import:

```ts
import { unionNativeFeeds } from "../../domain/native-feed";
```

(b) In the detail handler, after `const feedMetadata = await repo.getMetadata(id);` (line 137) and the null guard (line 139), compute:

```ts
const nativeFeeds = unionNativeFeeds(feedMetadata.nativeFeeds);
```

(c) Render the group right after `<FeedFormats feedId={feedId} env={env} />` (line 166):

```tsx
          <FeedFormats feedId={feedId} env={env} />
          <NativeFeeds feeds={nativeFeeds} />
```

(d) Add the dismissable banner right after the confirmation-banner block (after line 186):

```tsx
{
  nativeFeeds.length > 0 && !feedMetadata.nativeFeedDismissed && (
    <div
      class="confirmation-banner"
      id="native-feed-banner"
      data-feed-id={feedId}
    >
      <span>
        This newsletter publishes its own feed — subscribe to it directly from
        "Native feeds" above.
      </span>
      <div class="confirmation-banner-actions">
        <button
          type="button"
          class="button button-small"
          id="native-feed-dismiss"
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Add the dismiss route in `src/routes/admin/emails.tsx`**

After the confirmation dismiss route (after its closing `});`, ~line 733) add:

```ts
// ── Dismiss native-feed notice ───────────────────────────────────────────────

emailsRouter.post("/feeds/:feedId/native-feed/dismiss", async (c) => {
  const env = c.env;
  const repo = FeedRepository.from(env);
  const feedId = c.req.param("feedId");
  const wantsJson = (
    c.req.header("Accept") ||
    c.req.header("Content-Type") ||
    ""
  ).includes("application/json");

  const feed = await repo.load(FeedId.unchecked(feedId));
  if (!feed) {
    return wantsJson
      ? c.json({ ok: false, error: "Feed not found" }, 404)
      : c.text("Feed not found", 404);
  }
  feed.dismissNativeFeed();
  await repo.saveMetadata(feed);

  return wantsJson
    ? c.json({ ok: true })
    : c.redirect(`/admin/feeds/${feedId}/emails`);
});
```

- [ ] **Step 5: Add the client dismiss handler**

Append to `src/scripts/client/emails-page.ts` (after line 636):

```ts
// ── Native-feed banner dismiss ────────────────────────────────────────────────

const nativeDismissBtn = document.getElementById("native-feed-dismiss");
const nativeBanner = document.getElementById("native-feed-banner");
if (nativeDismissBtn && nativeBanner) {
  nativeDismissBtn.addEventListener("click", () => {
    const feedId = nativeBanner.getAttribute("data-feed-id") ?? "";
    fetch(`/admin/feeds/${feedId}/native-feed/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((r) => r.json())
      .then((d) => {
        if ((d as { ok?: boolean }).ok) nativeBanner.remove();
      })
      .catch(() => {});
  });
}
```

- [ ] **Step 6: Rebuild client scripts**

Run: `npm run build:client`
Expected: rebuilds `src/scripts/generated/` with no errors.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts -t "native"`
Expected: PASS (detail group, dashboard pill, dismiss route).

- [ ] **Step 8: Commit**

```bash
git add src/routes/admin/emails.tsx src/scripts/client/emails-page.ts src/routes/admin.test.ts
git commit -m "feat(admin): native-feed detail group + dismissable notice"
```

---

### Task 9: Styles

**Files:**

- Modify: `src/styles/components.css` (add `.pill-native` after `.pill-confirmation:hover` ~line 1392; add `.native-feeds` spacing)

No unit test (CSS) — verified via the build + a manual dev-server check at the end.

- [ ] **Step 1: Add `.pill-native` and `.native-feeds` rules**

After the `.pill-confirmation:hover { … }` block (~line 1392) in `src/styles/components.css`, add:

```css
/* Dashboard pill — <a class="pill pill-native"> */
.pill-native {
  background: var(--color-surface);
  color: var(--color-primary);
  border-color: var(--color-primary);
  text-decoration: none;
  transition:
    opacity var(--transition-fast),
    transform var(--transition-fast);
}

.pill-native:hover {
  opacity: 0.88;
  transform: translateY(-1px);
}

/* Native-feeds group sits below the KTN "Subscribe" chips */
.native-feeds {
  margin-top: var(--spacing-sm);
}
```

- [ ] **Step 2: Verify the build**

Run: `npm run build`
Expected: dry-run deploy bundle succeeds.

- [ ] **Step 3: Commit**

```bash
git add src/styles/components.css
git commit -m "style(admin): pill-native + native-feeds group spacing"
```

---

### Task 10: Documentation

**Files:**

- Modify: `README.md`, `INSTALL.md`, `docs/index.html`, `CLAUDE.md`, `TODO.md`

- [ ] **Step 1: README.md** — under the features/feed section, add a bullet:

```md
- **Native feed detection** — when a newsletter advertises its own RSS/Atom/JSON feed, KTN surfaces it in the admin (and the REST API) so you can subscribe to the source directly.
```

- [ ] **Step 2: INSTALL.md** — add a short note where other automatic ingestion behaviors (confirmation detection, favicons) are documented, explaining that native feeds are detected from `<link rel="alternate">` and shown per feed; no configuration required.

- [ ] **Step 3: docs/index.html (marketing landing)** — add a feature card matching the existing card markup/section style, headline e.g. "Find the source feed", body: "If a newsletter already publishes RSS/Atom/JSON, KTN spots it and points you to the original — subscribe at the source when you prefer." (It's a differentiator we ship before upstream.)

- [ ] **Step 4: CLAUDE.md** — in the `src/domain/` source-layout list, add:

```md
    native-feed.ts          # Detect a newsletter's self-advertised Atom/RSS/JSON feed (pure)
```

and in the KV-schema `feed:<feedId>:metadata` row, extend the value shape note to mention `nativeFeeds` (per-sender `Record`) and `nativeFeedDismissed`.

- [ ] **Step 5: TODO.md** — mark the item done. Change the line (currently ~line 67) from `- [ ] `P2·S` **Detect a newsletter's native Atom/RSS feed**` to `- [x]` and append a `— **Shipped:**` note summarizing: per-sender detection of `<link rel=alternate>` (Atom/RSS/JSON), admin detail group + dashboard pill + dismiss, read-only REST `FeedSchema.nativeFeeds`.

- [ ] **Step 6: Commit**

```bash
git add README.md INSTALL.md docs/index.html CLAUDE.md TODO.md
git commit -m "docs: document native feed detection; mark TODO item shipped"
```

---

### Task 11: Full verification gate

- [ ] **Step 1: Type-check** — `npx tsc --noEmit` → no errors.
- [ ] **Step 2: Tests** — `npm test` → all green.
- [ ] **Step 3: Build** — `npm run build` → dry-run deploy succeeds.
- [ ] **Step 4: Manual UI check** — `npm run dev`, create a feed, POST an email containing `<link rel="alternate" type="application/rss+xml" href="https://blog.example.com/feed.xml">` to its inbound webhook, then:
  - the feed's emails page shows a "Native feeds" group with a copyable RSS chip;
  - the dashboard shows the `pill-native` pill;
  - clicking "Dismiss" removes the banner and the pill disappears on reload, but the chip stays;
  - `GET /api/v1/feeds/<id>` (Bearer admin password) returns `nativeFeeds: [{ url, type: "rss" }]`.
- [ ] **Step 5:** If any check fails, fix and re-run the gate before declaring done.

---

## Notes for the implementer

- **DRY senderKey:** Task 5 deliberately computes `senderKey` once and shares it between `unsub` and `nativeFeeds` — do not duplicate the `input.senders[0] || iconDomain || input.from` expression.
- **Additive persistence:** `nativeFeeds`/`nativeFeedDismissed` live on `FeedMetadata`, which is stored directly in KV (no mapper translation for the metadata blob). Pre-feature feeds simply have them `undefined` → `hasNativeFeed()` is `false`. No migration.
- **No public XML change:** native feeds are intentionally NOT emitted into the rendered RSS/Atom/JSON output — admin + REST only.
- **Test harness fidelity:** Tasks 5–8 reference helpers (`seedFeed`, `buildInput`, `request`, etc.) by intent. Always match the actual helpers/imports already used in the target test file rather than introducing new ones.
- **One admin surface, not two:** the spec mentioned a "list badge" _and_ a "dashboard pill". Because a native feed is a feed-level fact (not per-email), these collapse to a single surface — the `pill-native` on the dashboard feed table — plus the copyable group on the feed detail page. There is no separate per-email badge (unlike confirmation, which is per-email).
