import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { Feed, CreateFeedInput } from "./feed.aggregate";
import { FeedRepository } from "./feed-repository";
import type { Env, EmailMetadata } from "../types";

const mockEnv = (overrides: Partial<Env> = {}) =>
  ({ ...createMockEnv(), ...overrides }) as unknown as Env;

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
    const feed = Feed.create("a.b.42", createInput(), mockEnv());
    expect(feed.id).toBe("a.b.42");
    expect(feed.config.title).toBe("News");
    expect(feed.config.expires_at).toBeUndefined();
    expect(feed.metadata.emails).toEqual([]);
  });

  it("resolves expiry from lifetimeHours", () => {
    const feed = Feed.create(
      "a.b.42",
      createInput({ lifetimeHours: 1 }),
      mockEnv(),
    );
    expect(feed.config.expires_at).toBeGreaterThan(Date.now());
  });

  it("lets FEED_TTL_HOURS override a client lifetime", () => {
    const feed = Feed.create(
      "a.b.42",
      createInput({ lifetimeHours: 1000000 }),
      mockEnv({ FEED_TTL_HOURS: "1" }),
    );
    const oneClientHour = Date.now() + 1000000 * 3_600_000;
    expect(feed.config.expires_at).toBeLessThan(oneClientHour);
  });
});

describe("Feed.isExpired / accepts", () => {
  it("reports expiry against the configured instant", () => {
    const feed = Feed.reconstitute(
      "a.b.42",
      { title: "T", language: "en", created_at: 0, expires_at: 100 },
      { emails: [] },
    );
    expect(feed.isExpired(50)).toBe(false);
    expect(feed.isExpired(150)).toBe(true);
  });

  it("applies the sender policy", () => {
    const feed = Feed.reconstitute(
      "a.b.42",
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

describe("Feed.ingest", () => {
  it("prepends the entry, tracks icon/unsub and trims to the byte budget", () => {
    const feed = Feed.reconstitute(
      "a.b.42",
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

    expect(feed.metadata.emails[0].key).toBe("new");
    expect(feed.metadata.iconDomain).toBe("example.com");
    expect(feed.metadata.unsubscribe).toEqual({
      "news@example.com": "https://u/1",
    });
    expect(dropped.map((e) => e.key)).toEqual(["old"]);
    expect(feed.metadata.emails.map((e) => e.key)).toEqual(["new"]);
  });
});

describe("Feed.removeEmails", () => {
  it("drops matching keys and returns the removed entries", () => {
    const feed = Feed.reconstitute(
      "a.b.42",
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
    expect(feed.metadata.emails.map((e) => e.key)).toEqual(["k2"]);
  });
});

describe("FeedRepository.load / save round-trip", () => {
  it("persists a created feed and reflects later mutations", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    const created = Feed.create(
      "a.b.42",
      createInput({ title: "Round" }),
      mockEnv(),
    );
    await repo.save(created);

    const loaded = await repo.load("a.b.42");
    expect(loaded).not.toBeNull();
    expect(loaded!.config.title).toBe("Round");

    loaded!.ingest(entry({ key: "feed:a.b.42:1" }), { maxBytes: 1_000_000 });
    await repo.saveMetadata(loaded!);

    const reloaded = await repo.load("a.b.42");
    expect(reloaded!.metadata.emails.map((e) => e.key)).toEqual([
      "feed:a.b.42:1",
    ]);
  });

  it("returns null when the feed has no config", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.load("missing")).toBeNull();
  });
});
