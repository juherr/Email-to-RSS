import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { Feed, CreateFeedInput } from "./feed.aggregate";
import { FeedRepository } from "../infrastructure/feed-repository";
import { FeedId } from "./value-objects/feed-id";
import { Clock } from "./clock";
import type { Env, EmailMetadata } from "../types";

const FID = FeedId.fromTrusted("a.b.42");

const mockEnv = () => createMockEnv() as unknown as Env;

const fixedClock = (now: number): Clock => ({ now: () => now });

const createInput = (
  overrides: Partial<CreateFeedInput> = {},
): CreateFeedInput => ({
  title: "News",
  language: "en",
  allowedSenders: [],
  blockedSenders: [],
  ...overrides,
});

const entry = (overrides: Partial<EmailMetadata> = {}): EmailMetadata => ({
  key: "feed:a.b.42:1",
  subject: "Hello",
  receivedAt: 1,
  size: 10,
  ...overrides,
});

describe("Feed.create", () => {
  it("builds a config with an empty email index and no expiry by default", () => {
    const feed = Feed.create(FID, createInput());
    expect(feed.id.value).toBe("a.b.42");
    expect(feed.title).toBe("News");
    expect(feed.expiresAt).toBeUndefined();
    expect(feed.emails).toEqual([]);
  });

  it("resolves expiry from the supplied ttlHours using the injected clock", () => {
    const NOW = 1_000_000;
    const feed = Feed.create(FID, createInput(), {
      clock: fixedClock(NOW),
      ttlHours: 2,
    });
    expect(feed.createdAt).toBe(NOW);
    expect(feed.updatedAt).toBe(NOW);
    expect(feed.expiresAt).toBe(NOW + 2 * 3_600_000);
  });

  it("trusts only deps.ttlHours, not the client lifetimeHours field", () => {
    // The aggregate no longer parses lifetime policy: the application resolves
    // the effective ttlHours (env override etc.) and hands it in.
    const feed = Feed.create(FID, createInput({ lifetimeHours: 9999 }), {
      ttlHours: undefined,
    });
    expect(feed.expiresAt).toBeUndefined();
  });

  it("treats a non-positive ttlHours as no expiry", () => {
    expect(
      Feed.create(FID, createInput(), { ttlHours: 0 }).expiresAt,
    ).toBeUndefined();
    expect(
      Feed.create(FID, createInput(), { ttlHours: -5 }).expiresAt,
    ).toBeUndefined();
  });
});

describe("Feed.isExpired / accepts", () => {
  it("reports expiry against the configured instant", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0, expires_at: 100 },
      { emails: [] },
    );
    expect(feed.isExpired(50)).toBe(false);
    expect(feed.isExpired(150)).toBe(true);
  });

  it("uses the injected clock when no instant is supplied", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0, expires_at: 100 },
      { emails: [] },
      fixedClock(150),
    );
    expect(feed.isExpired()).toBe(true);
  });

  it("applies the sender policy", () => {
    const feed = Feed.reconstitute(
      FID,
      {
        title: "T",
        language: "en",
        created_at: 0,
        allowed_senders: ["good@example.com"],
      },
      { emails: [] },
    );
    expect(feed.accepts(["good@example.com"])).toBe("accepted");
    expect(feed.accepts(["bad@example.com"])).toBe("blocked");
  });
});

describe("Feed.edit", () => {
  it("recomputes expiry only when asked", () => {
    const NOW = 5_000_000;
    const FUTURE = NOW + 10 * 3_600_000;
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0, expires_at: FUTURE },
      { emails: [] },
      fixedClock(NOW),
    );

    feed.edit({ title: "T2" }, { recomputeExpiry: false });
    expect(feed.expiresAt).toBe(FUTURE); // preserved
    expect(feed.updatedAt).toBe(NOW);

    feed.edit({ title: "T3" }, { recomputeExpiry: true, ttlHours: 1 });
    expect(feed.expiresAt).toBe(NOW + 3_600_000);
  });

  it("refuses to edit an already-expired feed", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0, expires_at: 100 },
      { emails: [] },
      fixedClock(200),
    );
    expect(feed.edit({ title: "X" }).status).toBe("expired");
  });
});

describe("Feed.ingest", () => {
  it("prepends the entry, tracks icon/unsub and trims to the byte budget", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0 },
      {
        emails: [entry({ key: "old", size: 400 })],
      },
    );

    const { dropped } = feed.ingest(entry({ key: "new", size: 400 }), {
      maxBytes: 500,
      iconDomain: "example.com",
      unsub: { senderKey: "news@example.com", url: "https://u/1" },
    });

    expect(feed.emails[0].key).toBe("new");
    expect(feed.iconDomain).toBe("example.com");
    expect(feed.unsubscribeUrls()).toEqual({
      "news@example.com": "https://u/1",
    });
    expect(dropped.map((e) => e.key)).toEqual(["old"]);
    expect(feed.emails.map((e) => e.key)).toEqual(["new"]);
  });

  it("always keeps the just-ingested entry, even when it alone is oversized", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0 },
      { emails: [] },
    );

    const { dropped } = feed.ingest(entry({ key: "huge", size: 999 }), {
      maxBytes: 1,
    });

    expect(dropped).toEqual([]);
    expect(feed.emails.map((e) => e.key)).toEqual(["huge"]);
  });
});

describe("Feed.removeEmails", () => {
  it("drops matching keys and returns the removed entries", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0 },
      {
        emails: [
          entry({ key: "k1" }),
          entry({ key: "k2" }),
          entry({ key: "k3" }),
        ],
      },
    );

    const { removed } = feed.removeEmails(["k1", "k3", "missing"]);
    expect(removed.map((e) => e.key).sort()).toEqual(["k1", "k3"]);
    expect(feed.emails.map((e) => e.key)).toEqual(["k2"]);
  });
});

describe("Feed events", () => {
  it("records FeedCreated on create and drains it once", () => {
    const feed = Feed.create(FID, createInput());
    expect(feed.pullEvents()).toEqual([{ type: "FeedCreated" }]);
    // Draining clears: a second pull is empty.
    expect(feed.pullEvents()).toEqual([]);
  });

  it("records EmailIngested (with icon domain) on ingest", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0 },
      { emails: [] },
    );
    feed.ingest(entry({ key: "k" }), {
      maxBytes: 1_000_000,
      iconDomain: "example.com",
    });
    expect(feed.pullEvents()).toEqual([
      { type: "EmailIngested", iconDomain: "example.com" },
    ]);
  });

  it("emits no events for edit / removeEmails", () => {
    const feed = Feed.reconstitute(
      FID,
      { title: "T", language: "en", created_at: 0, expires_at: 9_999_999_999 },
      { emails: [entry({ key: "k1" })] },
      fixedClock(1000),
    );
    feed.edit({ title: "X" }, { recomputeExpiry: false });
    feed.edit({ description: "Y" }, { recomputeExpiry: false });
    feed.removeEmails(["k1"]);
    expect(feed.pullEvents()).toEqual([]);
  });
});

describe("FeedRepository.load / save round-trip", () => {
  it("persists a created feed and reflects later mutations", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    const created = Feed.create(FID, createInput({ title: "Round" }));
    await repo.save(created);

    const loaded = await repo.load(FID);
    expect(loaded).not.toBeNull();
    expect(loaded!.title).toBe("Round");

    loaded!.ingest(entry({ key: "feed:a.b.42:1" }), { maxBytes: 1_000_000 });
    await repo.saveMetadata(loaded!);

    const reloaded = await repo.load(FID);
    expect(reloaded!.emails.map((e) => e.key)).toEqual(["feed:a.b.42:1"]);
  });

  it("returns null when the feed has no config", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.load(FeedId.fromTrusted("missing"))).toBeNull();
  });
});
