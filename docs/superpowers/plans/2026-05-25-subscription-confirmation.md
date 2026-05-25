# Subscription Confirmation Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect newsletter "confirm your subscription" emails at ingestion, mark them, and surface the confirmation link(s) in the admin (detail section, list badge, dashboard pill, emails-page banner) so the user can click to confirm.

**Architecture:** A pure domain service (`src/domain/confirmation.ts`) scores subject/body keywords + link signals and returns ranked candidate links. Infra extracts links/text from the email HTML; the result is persisted on `EmailMetadata.confirmation`, and a feed-level `pendingConfirmation` flag is raised on the `Feed` aggregate, persisted on `FeedMetadata`, and projected into `feeds:list` so the dashboard stays at one KV read. v1 performs no outbound request.

**Tech Stack:** TypeScript, Cloudflare Workers, Hono + hono/jsx, linkedom (HTML parsing), Vitest, MSW.

**Spec:** `docs/superpowers/specs/2026-05-25-subscription-confirmation-design.md`

---

## File structure

| File                                                    | Responsibility                                                                                       | Action                    |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------- |
| `src/domain/confirmation.ts`                            | Pure detection: keyword + link scoring → ranked links                                                | Create                    |
| `src/domain/confirmation.test.ts`                       | Unit tests for detection                                                                             | Create                    |
| `src/infrastructure/html-processor.ts`                  | Add `extractLinks(content)`                                                                          | Modify                    |
| `src/infrastructure/html-processor.test.ts`             | Tests for `extractLinks`                                                                             | Modify (create if absent) |
| `src/types/index.ts`                                    | `EmailMetadata.confirmation`, `FeedMetadata.pendingConfirmation`, `FeedListItem.pendingConfirmation` | Modify                    |
| `src/domain/feed.aggregate.ts`                          | Raise/recompute/clear `pendingConfirmation`                                                          | Modify                    |
| `src/domain/feed.aggregate.test.ts`                     | Aggregate flag tests                                                                                 | Modify (create if absent) |
| `src/infrastructure/feed-mapper.ts`                     | `toListItemDTO` carries the flag                                                                     | Modify                    |
| `src/infrastructure/feed-repository.ts`                 | `saveMetadata` projects flag into list                                                               | Modify                    |
| `src/application/email-processor.ts`                    | Wire detection into ingestion                                                                        | Modify                    |
| `src/application/email-processor.test.ts`               | Ingestion-marks-confirmation test                                                                    | Modify                    |
| `src/routes/admin/emails.tsx`                           | Detail section, list badge, banner, dismiss route                                                    | Modify                    |
| `src/scripts/client/emails-page.ts`                     | Dismiss-banner click handler                                                                         | Modify                    |
| `src/routes/admin.tsx`                                  | Dashboard pill (list + table)                                                                        | Modify                    |
| `src/routes/admin/feeds.tsx`                            | Post-creation redirect to emails page                                                                | Modify                    |
| `src/styles/components.css`                             | Styles for badge/pill/banner/section                                                                 | Modify                    |
| `README.md`, `INSTALL.md`, `docs/index.html`, `TODO.md` | Docs + landing + TODO bookkeeping                                                                    | Modify                    |

---

## Task 1: Domain detection service

**Files:**

- Create: `src/domain/confirmation.ts`
- Test: `src/domain/confirmation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/domain/confirmation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { detectConfirmation } from "./confirmation";

describe("detectConfirmation", () => {
  it("detects an English confirmation email and returns the confirm link", () => {
    const result = detectConfirmation({
      subject: "Please confirm your subscription",
      text: "Click the button below to verify your email address.",
      links: [
        {
          href: "https://news.example.com/confirm?token=abc123",
          text: "Confirm subscription",
        },
        { href: "https://news.example.com/home", text: "Home" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.links[0]).toBe(
      "https://news.example.com/confirm?token=abc123",
    );
  });

  it("detects a French confirmation email (accent-insensitive)", () => {
    const result = detectConfirmation({
      subject: "Confirmez votre inscription",
      text: "Cliquez pour activer votre abonnement.",
      links: [
        {
          href: "https://lettre.example.fr/valider/xyz",
          text: "Valider mon inscription",
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.links[0]).toBe("https://lettre.example.fr/valider/xyz");
  });

  it("returns null for a normal newsletter with only an unsubscribe link", () => {
    const result = detectConfirmation({
      subject: "This week in tech",
      text: "Here are the top stories. To stop receiving these, unsubscribe here.",
      links: [
        { href: "https://news.example.com/article/42", text: "Read more" },
        {
          href: "https://news.example.com/unsubscribe?u=9",
          text: "Unsubscribe",
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when no candidate link is present even if the subject matches", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "Reply to this email to confirm.",
      links: [],
    });
    expect(result).toBeNull();
  });

  it("never treats an unsubscribe link as a confirmation candidate", () => {
    const result = detectConfirmation({
      subject: "Confirm your email",
      text: "Verify your address.",
      links: [
        { href: "https://x.example/verify/abc", text: "Verify email" },
        { href: "https://x.example/unsubscribe", text: "unsubscribe" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.links).not.toContain("https://x.example/unsubscribe");
  });

  it("ranks the strongest candidate first and caps at three links", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "verify activate",
      links: [
        { href: "https://x.example/help", text: "help" },
        { href: "https://x.example/a?token=1", text: "click" },
        { href: "https://x.example/confirm?token=2", text: "Confirm" },
        { href: "https://x.example/activate", text: "Activate account" },
        { href: "https://x.example/verify", text: "Verify" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.links.length).toBeLessThanOrEqual(3);
    expect(result!.links[0]).toBe("https://x.example/confirm?token=2");
  });

  it("ignores non-http(s) links", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "verify",
      links: [{ href: "mailto:confirm@x.example", text: "confirm" }],
    });
    expect(result).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/confirmation.test.ts`
Expected: FAIL — `detectConfirmation` is not defined / module not found.

- [ ] **Step 3: Write the implementation**

Create `src/domain/confirmation.ts`:

```ts
/**
 * Pure detection of "confirm your subscription" emails. No DOM, no I/O — it
 * receives already-extracted subject/body text and link tuples (infra parses the
 * HTML). This module owns the business knowledge: the multilingual keyword vocab,
 * the link-signal patterns, the scoring weights and the threshold.
 *
 * Returns the ranked candidate confirmation links (top 3) when the combined score
 * clears the threshold AND at least one candidate link exists; otherwise null.
 * Only http(s) links are ever considered or returned.
 */

export interface DetectConfirmationInput {
  subject: string;
  text: string;
  links: { href: string; text: string }[];
}

export interface ConfirmationResult {
  score: number;
  links: string[];
}

// Confirmation-positive stems, already normalized (lowercased, diacritics stripped).
// EN / FR / DE / ES — extend here to add a language.
const KEYWORDS = [
  "confirm", // confirm, confirmation, confirmer, confirmar
  "verif", // verify, verification, verifier, verificar
  "activ", // activate, activation, activer, activar
  "valid", // validate, valider, validar
  "bestatig", // bestätigen / bestätigung (normalized)
  "aktivier", // aktivieren
  "opt-in",
  "opt in",
  "optin",
];

// Link URL/anchor signals (normalized). A link matching any → candidate.
const LINK_SIGNALS = [
  "confirm",
  "verif",
  "activ",
  "valid",
  "bestatig",
  "aktivier",
  "optin",
  "opt-in",
  "double-optin",
  "subscription",
  "subscribe",
  "token=",
  "confirm=",
  "activation",
];

// Negative patterns: a link matching any of these is NEVER a candidate, and these
// tokens are stripped from text before keyword scanning (kills the unsubscribe
// false positive — "unsubscribe" contains "subscribe").
const NEGATIVE = [
  "unsubscribe",
  "desabonn",
  "desinscri",
  "abbestell",
  "opt-out",
  "optout",
  "list-unsubscribe",
];

const THRESHOLD = 3;

function normalize(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

function isHttp(href: string): boolean {
  return /^https?:\/\//i.test(href.trim());
}

function matchesAny(haystack: string, needles: string[]): boolean {
  return needles.some((n) => haystack.includes(n));
}

function keywordHits(haystack: string): number {
  return KEYWORDS.reduce((n, kw) => (haystack.includes(kw) ? n + 1 : n), 0);
}

function linkScore(href: string, text: string): number {
  const h = normalize(href);
  const t = normalize(text);
  if (matchesAny(h, NEGATIVE) || matchesAny(t, NEGATIVE)) return 0;
  let score = 0;
  if (matchesAny(h, LINK_SIGNALS)) score += 2;
  if (matchesAny(t, KEYWORDS)) score += 2;
  return score;
}

function stripNegatives(text: string): string {
  let out = text;
  for (const n of NEGATIVE) out = out.split(n).join(" ");
  return out;
}

export function detectConfirmation(
  input: DetectConfirmationInput,
): ConfirmationResult | null {
  const candidates = input.links
    .filter((l) => isHttp(l.href))
    .map((l) => ({ href: l.href.trim(), score: linkScore(l.href, l.text) }))
    .filter((l) => l.score > 0)
    .sort((a, b) => b.score - a.score);

  if (candidates.length === 0) return null;

  const subject = stripNegatives(normalize(input.subject));
  const text = stripNegatives(normalize(input.text));

  const subjectScore = keywordHits(subject) > 0 ? 2 : 0;
  const bodyScore = keywordHits(text) > 0 ? 1 : 0;
  const bestLinkScore = candidates[0].score;

  const score = subjectScore + bodyScore + bestLinkScore;
  if (score < THRESHOLD) return null;

  return { score, links: candidates.slice(0, 3).map((c) => c.href) };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/confirmation.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/domain/confirmation.ts src/domain/confirmation.test.ts
git commit -m "feat(domain): confirmation-email detection service"
```

---

## Task 2: Extract links (infrastructure)

**Files:**

- Modify: `src/infrastructure/html-processor.ts`
- Test: `src/infrastructure/html-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/infrastructure/html-processor.test.ts` (create the file with this content if it does not exist; if it exists, add the `describe` block and import `extractLinks`):

```ts
import { describe, it, expect } from "vitest";
import { extractLinks } from "./html-processor";

describe("extractLinks", () => {
  it("collects anchor href + text from HTML", () => {
    const links = extractLinks(
      '<p>hi <a href="https://x.example/confirm?t=1">Confirm</a> and <a href="https://x.example/home">Home</a></p>',
    );
    expect(links).toEqual([
      { href: "https://x.example/confirm?t=1", text: "Confirm" },
      { href: "https://x.example/home", text: "Home" },
    ]);
  });

  it("falls back to regex URL extraction for plain text", () => {
    const links = extractLinks(
      "Confirm here: https://x.example/verify/abc thanks",
    );
    expect(links).toEqual([
      {
        href: "https://x.example/verify/abc",
        text: "https://x.example/verify/abc",
      },
    ]);
  });

  it("returns an empty array for empty content", () => {
    expect(extractLinks("")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/infrastructure/html-processor.test.ts`
Expected: FAIL — `extractLinks` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/infrastructure/html-processor.ts`, add this exported function (place it after `htmlToText`, near the top-level helpers). It reuses the existing `parseHTML` import and the existing `isPlainText` helper:

```ts
// Collect the links from an email body for confirmation detection: anchor href +
// visible text from HTML, or a regex URL sweep for plain-text bodies. Infra owns
// the DOM parse; the domain detector receives plain tuples.
export function extractLinks(
  content: string,
): { href: string; text: string }[] {
  if (!content) return [];

  if (isPlainText(content)) {
    const urls = content.match(/https?:\/\/[^\s<>"')]+/gi) ?? [];
    return urls.map((url) => ({ href: url, text: url }));
  }

  const { document } = parseHTML(content);
  const links: { href: string; text: string }[] = [];
  document.querySelectorAll("a[href]").forEach((el: Element) => {
    const href = (el.getAttribute("href") ?? "").trim();
    if (!href) return;
    links.push({
      href,
      text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
    });
  });
  return links;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/infrastructure/html-processor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/html-processor.ts src/infrastructure/html-processor.test.ts
git commit -m "feat(infra): extractLinks for confirmation detection"
```

---

## Task 3: Types + aggregate flag

**Files:**

- Modify: `src/types/index.ts`
- Modify: `src/domain/feed.aggregate.ts`
- Test: `src/domain/feed.aggregate.test.ts`

- [ ] **Step 1: Add the type fields**

In `src/types/index.ts`, add to `EmailMetadata` (after `dedupHash`):

```ts
  // Detected subscription-confirmation links (ranked top-3). Present ⇒ the email
  // was detected as a confirmation request.
  confirmation?: { links: string[] };
```

Add to `FeedMetadata` (after `unsubscribe`):

```ts
  // True while at least one unactioned confirmation email is present. Raised on
  // ingest, lowered by an admin "dismiss" or when the last confirmation email is
  // removed. Projected into feeds:list for the dashboard.
  pendingConfirmation?: boolean;
```

Add to `FeedListItem` (after `expires_at`):

```ts
  pendingConfirmation?: boolean; // Projected from FeedMetadata for the dashboard
```

- [ ] **Step 2: Write the failing aggregate test**

Add to `src/domain/feed.aggregate.test.ts` (create the file with the imports below if it does not exist; otherwise append the `describe`). Adjust the existing-test imports if the file already imports these symbols:

```ts
import { describe, it, expect } from "vitest";
import { Feed } from "./feed.aggregate";
import { FeedId } from "./value-objects/feed-id";
import { MailboxId } from "./value-objects/mailbox-id";
import type { EmailMetadata } from "../types";

function newFeed(): Feed {
  return Feed.create(
    FeedId.generate(),
    {
      title: "T",
      description: "",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    },
    { mailboxId: MailboxId.unchecked("alpha.beta.10") },
  );
}

function email(key: string, confirmation?: { links: string[] }): EmailMetadata {
  return {
    key,
    subject: "s",
    receivedAt: Date.now(),
    size: 10,
    ...(confirmation ? { confirmation } : {}),
  };
}

describe("Feed pendingConfirmation", () => {
  it("is false on a fresh feed", () => {
    expect(newFeed().pendingConfirmation).toBe(false);
  });

  it("is raised when a confirmation email is ingested", () => {
    const feed = newFeed();
    feed.ingest(email("k1", { links: ["https://x/confirm"] }), {
      maxBytes: 1_000_000,
    });
    expect(feed.pendingConfirmation).toBe(true);
  });

  it("stays false for a non-confirmation email", () => {
    const feed = newFeed();
    feed.ingest(email("k1"), { maxBytes: 1_000_000 });
    expect(feed.pendingConfirmation).toBe(false);
  });

  it("is cleared by dismissConfirmation", () => {
    const feed = newFeed();
    feed.ingest(email("k1", { links: ["https://x/confirm"] }), {
      maxBytes: 1_000_000,
    });
    feed.dismissConfirmation();
    expect(feed.pendingConfirmation).toBe(false);
  });

  it("does not re-raise after dismiss when removing an unrelated email", () => {
    const feed = newFeed();
    feed.ingest(email("k1", { links: ["https://x/confirm"] }), {
      maxBytes: 1_000_000,
    });
    feed.ingest(email("k2"), { maxBytes: 1_000_000 });
    feed.dismissConfirmation();
    feed.removeEmails(["k2"]);
    expect(feed.pendingConfirmation).toBe(false);
  });

  it("clears when the last confirmation email is removed", () => {
    const feed = newFeed();
    feed.ingest(email("k1", { links: ["https://x/confirm"] }), {
      maxBytes: 1_000_000,
    });
    feed.removeEmails(["k1"]);
    expect(feed.pendingConfirmation).toBe(false);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/domain/feed.aggregate.test.ts`
Expected: FAIL — `pendingConfirmation` / `dismissConfirmation` not defined.

- [ ] **Step 4: Implement on the aggregate**

In `src/domain/feed.aggregate.ts`:

Add a read accessor (place after the `iconDomain` getter, around line 156):

```ts
  /** True while at least one unactioned confirmation email is present. */
  get pendingConfirmation(): boolean {
    return this._metadata.pendingConfirmation ?? false;
  }
```

In `ingest()`, after the `if (opts.unsub) { ... }` block and before `this._events.push(...)`, add:

```ts
if (entry.confirmation) {
  this._metadata.pendingConfirmation = true;
}
```

In `removeEmails()`, replace the body so it recomputes the flag downward only (dismiss must stick when unrelated emails are removed):

```ts
  removeEmails(keys: string[]): { removed: EmailMetadata[] } {
    const target = new Set(keys);
    const removed: EmailMetadata[] = [];
    const kept: EmailMetadata[] = [];
    for (const entry of this._metadata.emails) {
      (target.has(entry.key) ? removed : kept).push(entry);
    }
    this._metadata.emails = kept;
    // Lower-only: clear when no confirmation email remains. Never re-raise here,
    // so an admin "dismiss" survives deletion of unrelated emails.
    if (!kept.some((e) => e.confirmation)) {
      this._metadata.pendingConfirmation = false;
    }
    return { removed };
  }
```

Add a new method (place after `removeEmails`):

```ts
  /** Mark the pending confirmation as handled — "stop reminding me". */
  dismissConfirmation(): void {
    this._metadata.pendingConfirmation = false;
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/domain/feed.aggregate.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/types/index.ts src/domain/feed.aggregate.ts src/domain/feed.aggregate.test.ts
git commit -m "feat(domain): pendingConfirmation flag on the Feed aggregate"
```

---

## Task 4: Project the flag into feeds:list

**Files:**

- Modify: `src/infrastructure/feed-mapper.ts`
- Modify: `src/infrastructure/feed-repository.ts`
- Test: `src/infrastructure/feed-repository.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/infrastructure/feed-repository.test.ts` (create with the imports below if absent; otherwise append the `describe`):

```ts
import { describe, it, expect } from "vitest";
import { FeedRepository } from "./feed-repository";
import { Feed } from "../domain/feed.aggregate";
import { FeedId } from "../domain/value-objects/feed-id";
import { MailboxId } from "../domain/value-objects/mailbox-id";
import { createMockEnv } from "../test/setup";

function makeFeed(): Feed {
  return Feed.create(
    FeedId.generate(),
    {
      title: "T",
      description: "",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    },
    { mailboxId: MailboxId.unchecked("alpha.beta.11") },
  );
}

describe("FeedRepository pendingConfirmation projection", () => {
  it("saveMetadata projects pendingConfirmation into feeds:list", async () => {
    const env = createMockEnv();
    const repo = FeedRepository.from(env);
    const feed = makeFeed();
    await repo.save(feed);

    feed.ingest(
      {
        key: "k1",
        subject: "s",
        receivedAt: Date.now(),
        size: 10,
        confirmation: { links: ["https://x/confirm"] },
      },
      { maxBytes: 1_000_000 },
    );
    await repo.saveMetadata(feed);

    const list = await repo.listFeeds();
    const entry = list.find((f) => f.id === feed.id.value);
    expect(entry?.pendingConfirmation).toBe(true);
  });

  it("saveMetadata clears the projected flag after dismiss", async () => {
    const env = createMockEnv();
    const repo = FeedRepository.from(env);
    const feed = makeFeed();
    feed.ingest(
      {
        key: "k1",
        subject: "s",
        receivedAt: Date.now(),
        size: 10,
        confirmation: { links: ["https://x/confirm"] },
      },
      { maxBytes: 1_000_000 },
    );
    await repo.save(feed);
    expect(
      (await repo.listFeeds()).find((f) => f.id === feed.id.value)
        ?.pendingConfirmation,
    ).toBe(true);

    feed.dismissConfirmation();
    await repo.saveMetadata(feed);
    expect(
      (await repo.listFeeds()).find((f) => f.id === feed.id.value)
        ?.pendingConfirmation,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/infrastructure/feed-repository.test.ts`
Expected: FAIL — `pendingConfirmation` is undefined on the list entry (saveMetadata does not touch the list yet).

- [ ] **Step 3: Implement the projection**

In `src/infrastructure/feed-mapper.ts`, change `toListItemDTO` to carry the flag:

```ts
/** Domain state → the projection cached in the global `feeds:list` registry. */
export function toListItemDTO(
  id: FeedId,
  state: FeedState,
  pendingConfirmation = false,
): FeedListItem {
  return {
    id: id.value,
    title: state.title,
    description: state.description,
    mailbox_id: state.mailboxId,
    expires_at: state.expiresAt,
    ...(pendingConfirmation ? { pendingConfirmation: true } : {}),
  };
}
```

In `src/infrastructure/feed-repository.ts`:

`save()` — pass the flag:

```ts
  async save(feed: Feed): Promise<void> {
    await Promise.all([
      this.putConfig(feed.id, toConfigDTO(feed.state())),
      this.putMetadata(feed.id, feed.toMetadataSnapshot()),
      this.upsertListEntry(
        toListItemDTO(feed.id, feed.state(), feed.pendingConfirmation),
      ),
      this.putInboundIndex(feed.mailboxId, feed.id),
    ]);
  }
```

`saveMetadata()` — now also refresh the list projection (this is the deliberate extra write that keeps the dashboard at one KV read):

```ts
  async saveMetadata(feed: Feed): Promise<void> {
    await Promise.all([
      this.putMetadata(feed.id, feed.toMetadataSnapshot()),
      this.upsertListEntry(
        toListItemDTO(feed.id, feed.state(), feed.pendingConfirmation),
      ),
    ]);
  }
```

`saveConfig()` — pass the flag:

```ts
  async saveConfig(feed: Feed): Promise<void> {
    await Promise.all([
      this.putConfig(feed.id, toConfigDTO(feed.state())),
      this.upsertListEntry(
        toListItemDTO(feed.id, feed.state(), feed.pendingConfirmation),
      ),
      this.putInboundIndex(feed.mailboxId, feed.id),
    ]);
  }
```

Update the `saveMetadata` doc-comment (lines ~95-99) to reflect that it now also refreshes the list's `pendingConfirmation` projection.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/infrastructure/feed-repository.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/infrastructure/feed-mapper.ts src/infrastructure/feed-repository.ts src/infrastructure/feed-repository.test.ts
git commit -m "feat(infra): project pendingConfirmation into feeds:list"
```

---

## Task 5: Wire detection into ingestion

**Files:**

- Modify: `src/application/email-processor.ts`
- Test: `src/application/email-processor.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/application/email-processor.test.ts` (follow the file's existing setup patterns — it already imports `processEmail`, `createMockEnv`, and seeds a feed; mirror an existing "stores an email" test for the feed/inbound setup). Add:

```ts
it("marks a confirmation email and raises pendingConfirmation", async () => {
  const env = createMockEnv();
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    FeedId.generate(),
    {
      title: "T",
      description: "",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    },
    { mailboxId: MailboxId.unchecked("alpha.beta.12") },
  );
  await repo.save(feed);

  const result = await processEmail(
    {
      toAddress: `alpha.beta.12@${env.DOMAIN}`,
      from: "news@example.com",
      senders: ["news@example.com"],
      subject: "Please confirm your subscription",
      content:
        '<p>Click <a href="https://example.com/confirm?token=abc">Confirm</a></p>',
      receivedAt: Date.now(),
    },
    env,
  );

  expect(result.ok).toBe(true);
  const reloaded = await repo.load(feed.id);
  expect(reloaded!.pendingConfirmation).toBe(true);
  expect(reloaded!.emails[0].confirmation?.links[0]).toBe(
    "https://example.com/confirm?token=abc",
  );
});
```

> Note: add any missing imports at the top of the test file: `Feed` from `../domain/feed.aggregate`, `FeedId` from `../domain/value-objects/feed-id`, `MailboxId` from `../domain/value-objects/mailbox-id`, `FeedRepository` from `../infrastructure/feed-repository`. If the file already seeds feeds a different way, reuse that helper instead of constructing `Feed` here.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/application/email-processor.test.ts`
Expected: FAIL — `confirmation` is undefined / `pendingConfirmation` is false.

- [ ] **Step 3: Implement the wire-in**

In `src/application/email-processor.ts`:

Replace the existing `import { extractInlineCids } from "../infrastructure/html-processor";` line with:

```ts
import {
  extractInlineCids,
  extractLinks,
  htmlToText,
} from "../infrastructure/html-processor";
import { detectConfirmation } from "../domain/confirmation";
```

In `storeEmail`, after the dedup early-return and before building `emailData`, compute detection:

```ts
const confirmation = detectConfirmation({
  subject: input.subject,
  text: htmlToText(input.content),
  links: extractLinks(input.content),
});
```

Then in the `newEntry: EmailMetadata` object literal, add the field after `dedupHash`:

```ts
    ...(confirmation ? { confirmation: { links: confirmation.links } } : {}),
```

(`feed.ingest(newEntry, ...)` already raises `pendingConfirmation` from Task 3; `repo.saveMetadata(feed)` already projects it from Task 4.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/application/email-processor.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/application/email-processor.ts src/application/email-processor.test.ts
git commit -m "feat(ingest): detect and mark confirmation emails"
```

---

## Task 6: Admin email detail section + list badge + banner + dismiss route

**Files:**

- Modify: `src/routes/admin/emails.tsx`
- Modify: `src/scripts/client/emails-page.ts`
- Test: `src/routes/admin.test.ts` (or the existing emails route test file)

- [ ] **Step 1: Write the failing test**

Add to `src/routes/admin.test.ts` (use the file's existing request helper / auth cookie pattern; mirror an existing admin test that seeds a feed + email via `FeedRepository`). Add three tests:

```ts
it("shows the confirmation section on the email detail view", async () => {
  const env = createMockEnv();
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    FeedId.generate(),
    {
      title: "T",
      description: "",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    },
    { mailboxId: MailboxId.unchecked("alpha.beta.20") },
  );
  const key = repo.newEmailKey(feed.id);
  await repo.putEmail(key, {
    subject: "Confirm your subscription",
    from: "news@example.com",
    content: '<a href="https://example.com/confirm?t=1">Confirm</a>',
    receivedAt: Date.now(),
    headers: {},
  });
  feed.ingest(
    {
      key,
      subject: "Confirm your subscription",
      receivedAt: Date.now(),
      size: 10,
      confirmation: { links: ["https://example.com/confirm?t=1"] },
    },
    { maxBytes: 1_000_000 },
  );
  await repo.save(feed);

  const res = await app.request(`/admin/emails/${key}`, authedInit(env), env);
  const html = await res.text();
  expect(html).toContain("Confirm your subscription");
  expect(html).toContain("https://example.com/confirm?t=1");
  expect(html).toContain("confirmation-section");
});

it("shows a confirmation badge in the email list", async () => {
  // ...seed as above, then request `/admin/feeds/${feed.id.value}/emails`
  // expect(html).toContain("confirmation-badge");
});

it("dismiss clears pendingConfirmation", async () => {
  // ...seed a feed with pendingConfirmation true, POST /admin/feeds/:id/confirmation/dismiss
  // then repo.load(feed.id) → pendingConfirmation === false
});
```

> Fill the second and third tests by mirroring the first test's seeding and the file's existing `authedInit`/cookie helper and CSRF/Origin header usage (the dismiss POST needs the same `Origin: https://${env.DOMAIN}` header other admin POST tests use). Add missing imports (`Feed`, `FeedId`, `MailboxId`, `FeedRepository`) at the top.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: FAIL — no confirmation markup; dismiss route 404.

- [ ] **Step 3: Implement the UI + route**

In `src/routes/admin/emails.tsx`:

(a) **Detail section.** In the `GET /emails/:emailKey` handler, after `const feedConfig = await repo.getConfig(...)`, read the metadata entry's links:

```ts
const feedMetadata = await repo.getMetadata(FeedId.unchecked(feedId));
const confirmationLinks =
  feedMetadata?.emails.find((e) => e.key === emailKey)?.confirmation?.links ??
  [];
```

Render a section just above the `<div class="toggle-view">` block:

```tsx
{
  confirmationLinks.length > 0 && (
    <div class="confirmation-section">
      <h2>Confirm your subscription</h2>
      <p class="muted">
        This looks like a subscription-confirmation email. Open the link to
        confirm.
      </p>
      <a
        class="button confirmation-primary"
        href={confirmationLinks[0]}
        target="_blank"
        rel="noopener noreferrer"
      >
        Confirm subscription
      </a>
      <div class="confirmation-links">
        {confirmationLinks.map((link) => (
          <a href={link} target="_blank" rel="noopener noreferrer">
            {link}
          </a>
        ))}
      </div>
    </div>
  );
}
```

(b) **List badge.** In `GET /feeds/:feedId/emails`, inside the `.map((email) => ...)`, compute `const isConfirmation = !!email.confirmation;` and render a badge inside `.subject-cell`, next to the attachment indicator:

```tsx
{
  isConfirmation ? (
    <span class="confirmation-badge" title="Subscription confirmation">
      Confirmation
    </span>
  ) : null;
}
```

(c) **Banner.** In the same handler (the `feedMetadata` 404 guard already ran, so `feedMetadata` is non-null here), before the `<h2>Emails (...)` heading, render:

```tsx
{
  feedMetadata.pendingConfirmation && (
    <div
      class="confirmation-banner"
      id="confirmation-banner"
      data-feed-id={feedId}
    >
      <span>A subscription-confirmation email was detected.</span>
      <div class="confirmation-banner-actions">
        <button
          type="button"
          class="button button-small"
          id="confirmation-dismiss"
        >
          Mark as confirmed
        </button>
      </div>
    </div>
  );
}
```

(d) **Dismiss route.** Add to `emailsRouter`:

```ts
emailsRouter.post("/feeds/:feedId/confirmation/dismiss", async (c) => {
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
  feed.dismissConfirmation();
  await repo.saveMetadata(feed);

  return wantsJson
    ? c.json({ ok: true })
    : c.redirect(`/admin/feeds/${feedId}/emails`);
});
```

In `src/scripts/client/emails-page.ts` — add a dismiss handler (the page already injects `window.__APP_CONFIG__` with `feedId`, and the script is compiled by esbuild). Append near the script's init/bottom:

```ts
const dismissBtn = document.getElementById("confirmation-dismiss");
const banner = document.getElementById("confirmation-banner");
if (dismissBtn && banner) {
  dismissBtn.addEventListener("click", () => {
    const feedId = banner.getAttribute("data-feed-id") ?? "";
    fetch(`/admin/feeds/${feedId}/confirmation/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((r) => r.json())
      .then((d) => {
        if (d.ok) banner.remove();
      })
      .catch(() => {});
  });
}
```

Rebuild the client script: `npm run build:client`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm run build:client && npx vitest run src/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/emails.tsx src/scripts/client/emails-page.ts src/routes/admin.test.ts
git commit -m "feat(admin): surface confirmation link, badge, banner + dismiss"
```

---

## Task 7: Dashboard pending-confirmation pill

**Files:**

- Modify: `src/routes/admin.tsx`
- Test: `src/routes/admin.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `src/routes/admin.test.ts`:

```ts
it("shows a pending-confirmation pill on the dashboard", async () => {
  const env = createMockEnv();
  const repo = FeedRepository.from(env);
  const feed = Feed.create(
    FeedId.generate(),
    {
      title: "Needs confirm",
      description: "",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    },
    { mailboxId: MailboxId.unchecked("alpha.beta.21") },
  );
  feed.ingest(
    {
      key: "k1",
      subject: "s",
      receivedAt: Date.now(),
      size: 10,
      confirmation: { links: ["https://x/confirm"] },
    },
    { maxBytes: 1_000_000 },
  );
  await repo.save(feed);

  const res = await app.request("/admin?view=list", authedInit(env), env);
  const html = await res.text();
  expect(html).toContain("pill-confirmation");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: FAIL — no `pill-confirmation` markup.

- [ ] **Step 3: Implement the pill**

In `src/routes/admin.tsx`, define a small component near `ExpiryBadge` (around line 395):

```tsx
const ConfirmationPill = ({ feedId }: { feedId: string }) => (
  <a class="pill pill-confirmation" href={`/admin/feeds/${feedId}/emails`}>
    Confirmation pending
  </a>
);
```

In the **table view** Title cell (inside the `<div class="feed-title-cell">` block, after the title `<div>`), render it when `feed.pendingConfirmation`:

```tsx
{
  feed.pendingConfirmation && <ConfirmationPill feedId={feed.id} />;
}
```

In the **list view** item header (after the `{feed.expires_at && <ExpiryBadge .../>}` line, around line 931), add:

```tsx
{
  feed.pendingConfirmation && <ConfirmationPill feedId={feed.id} />;
}
```

`feed.pendingConfirmation` is already on the `FeedListItem` (Task 4) and flows through `feedsWithConfig` unchanged (the spread at line 418 preserves it).

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin.tsx src/routes/admin.test.ts
git commit -m "feat(admin): dashboard pending-confirmation pill"
```

---

## Task 8: Post-creation redirect to the feed's emails page

**Files:**

- Modify: `src/routes/admin/feeds.tsx:141`
- Test: `src/routes/admin.test.ts` (or the feeds route test file)

- [ ] **Step 1: Write the failing test**

Add a test asserting the create redirect now points at the feed's emails page:

```ts
it("redirects to the feed emails page after creation", async () => {
  const env = createMockEnv();
  const form = new URLSearchParams({
    title: "My Feed",
    language: "en",
    view: "list",
  });
  const res = await app.request(
    "/admin/feeds/create",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Origin: `https://${env.DOMAIN}`,
        Cookie: authedCookie(env), // reuse the file's existing auth cookie helper
      },
      body: form.toString(),
      redirect: "manual",
    },
    env,
  );
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toMatch(/^\/admin\/feeds\/.+\/emails$/);
});
```

> Reuse the existing admin auth helper in the test file for the cookie/headers (mirror an existing `/admin/feeds/create` test if one exists).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: FAIL — redirect still points to `/admin?view=...`.

- [ ] **Step 3: Implement the redirect change**

In `src/routes/admin/feeds.tsx`, change line 141 from:

```ts
return c.redirect(`/admin?view=${view}#your-feeds`);
```

to:

```ts
return c.redirect(`/admin/feeds/${feedId}/emails`);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/routes/admin.test.ts`
Expected: PASS. (If an existing test asserted the old redirect target, update it to the new path.)

- [ ] **Step 5: Commit**

```bash
git add src/routes/admin/feeds.tsx src/routes/admin.test.ts
git commit -m "feat(admin): land on feed emails page after creation"
```

---

## Task 9: Styles

**Files:**

- Modify: `src/styles/components.css`

- [ ] **Step 1: Add the styles**

Append to `src/styles/components.css` (reuse existing CSS variables for colors/spacing):

```css
/* Subscription confirmation surfacing */
.confirmation-badge {
  flex: 0 0 auto;
  display: inline-flex;
  align-items: center;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: #fff;
  background: var(--color-primary);
  border-radius: 999px;
  padding: 1px 8px;
}

.pill-confirmation {
  background: var(--color-primary);
  color: #fff;
  text-decoration: none;
}

.confirmation-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--spacing-md);
  padding: var(--spacing-md);
  margin-bottom: var(--spacing-md);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md, 8px);
  background: var(--color-surface, #fff);
}

.confirmation-section {
  margin-bottom: var(--spacing-lg);
  padding: var(--spacing-md);
  border: 1px solid var(--color-primary);
  border-radius: var(--radius-md, 8px);
}

.confirmation-section h2 {
  margin: 0 0 var(--spacing-sm);
  font-size: var(--font-size-md);
}

.confirmation-primary {
  display: inline-block;
  margin-bottom: var(--spacing-sm);
}

.confirmation-links {
  display: flex;
  flex-direction: column;
  gap: 4px;
  word-break: break-all;
  font-size: var(--font-size-sm);
}
```

> If `--radius-md`/`--color-surface` are not defined in `src/styles/variables.css`, the inline fallbacks cover them; verify by grepping `variables.css` and drop the fallback if the variable already exists.

- [ ] **Step 2: Verify the build still bundles CSS**

Run: `npx tsc --noEmit && npm run build`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add src/styles/components.css
git commit -m "style(admin): confirmation badge, pill, banner, section"
```

---

## Task 10: Docs, landing, TODO bookkeeping

**Files:**

- Modify: `README.md`
- Modify: `INSTALL.md`
- Modify: `docs/index.html`
- Modify: `TODO.md`

- [ ] **Step 1: README** — add a bullet under the features list describing "Subscription confirmation surfacing: confirmation emails are detected and their confirm link is surfaced in the admin (detail section, list badge, dashboard pill, banner)." Match the surrounding bullet style.

- [ ] **Step 2: INSTALL.md** — add a short subsection "Subscription confirmation" explaining the admin behavior and that v1 performs no outbound request (the user clicks the link). Note the deferred server action options.

- [ ] **Step 3: Landing `docs/index.html`** — add a feature card matching the existing card markup/section style, headline e.g. "Never lose a confirmation link" with one sentence — a differentiator vs kill-the-newsletter. Grep the file for an existing feature card and copy its structure.

- [ ] **Step 4: TODO.md** — check off the item at line 51:

Change `- [ ] \`P1·M\` **Subscription confirmation handling**`to`- [x] \`P1·M\` **Subscription confirmation handling**`and append a short retrospective note:`— v1 ships detection + marking + admin surfacing (detail section, list badge, dashboard pill, banner). Server on-detect actions deferred (see below).`

Add a new item under the same section:

```markdown
- [ ] `P2·M` **Confirmation on-detect server action (none / autoclick / forward)** — extend the shipped confirmation detection with a server-configured action via an env var (default `none`): `autoclick` = follow the detected confirm link server-side from the worker (⚠ guard SSRF: http(s) only, no internal/private IPs, timeout, no redirect to non-http schemes); `forward` = forward the original email to `FALLBACK_FORWARD_ADDRESS`. Touches `src/application/email-processor.ts`, `Env` (`src/types/index.ts`), `src/infrastructure/cloudflare-email.ts`. — _origin: internal (juherr)_
```

- [ ] **Step 5: Commit**

```bash
git add README.md INSTALL.md docs/index.html TODO.md
git commit -m "docs: subscription confirmation surfacing + TODO bookkeeping"
```

---

## Task 11: Full green + final verification

**Files:** none (verification only)

- [ ] **Step 1: Typecheck**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 2: Full test suite**

Run: `npm test`
Expected: all tests pass (previous 445 + the new tests).

- [ ] **Step 3: Build (dry-run deploy)**

Run: `npm run build`
Expected: bundle succeeds.

- [ ] **Step 4: If anything failed, fix and re-run.** Do not declare done until all three are green.

---

## Self-review notes

- **Spec coverage:** detection (Task 1+2), data model (Task 3+4), ingestion wire-in (Task 5), detail section / list badge / banner / dismiss (Task 6), dashboard pill (Task 7), post-creation redirect (Task 8), styles (Task 9), docs/landing/TODO incl. deferred server-action item (Task 10), green close (Task 11). All spec sections mapped.
- **Type consistency:** `confirmation?: { links: string[] }` on `EmailMetadata`; `pendingConfirmation?: boolean` on `FeedMetadata` and `FeedListItem`; `Feed.pendingConfirmation` getter + `dismissConfirmation()`; `toListItemDTO(id, state, pendingConfirmation?)` — names match across tasks.
- **Security:** no outbound request in v1; candidate links filtered to http(s) in `detectConfirmation`; dismiss route under existing admin auth + CSRF (Origin header required, matching other admin POSTs); banner dismiss uses the compiled client script (no inline script injection).
