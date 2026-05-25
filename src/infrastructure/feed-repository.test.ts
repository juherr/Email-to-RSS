import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { FeedRepository } from "./feed-repository";
import { Feed } from "../domain/feed.aggregate";
import { FeedId } from "../domain/value-objects/feed-id";
import { MailboxId } from "../domain/value-objects/mailbox-id";
import type { Env, FeedConfig, FeedMetadata, EmailData } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;
const fid = (value: string) => FeedId.unchecked(value);

const sampleConfig = (overrides: Partial<FeedConfig> = {}): FeedConfig => ({
  title: "Test Feed",
  language: "en",
  mailbox_id: "test.feed.42",
  created_at: 1000,
  ...overrides,
});

const sampleEmail = (overrides: Partial<EmailData> = {}): EmailData => ({
  subject: "Hello",
  from: "news@example.com",
  content: "<p>hi</p>",
  receivedAt: 1234,
  headers: {},
  ...overrides,
});

describe("FeedRepository key schema", () => {
  it("builds the canonical KV keys via the public API", () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(repo.feedKeyPrefix(fid("a.b.42"))).toBe("feed:a.b.42:");
    expect(repo.newEmailKey(fid("a.b.42"))).toMatch(/^feed:a\.b\.42:\d+$/);
  });

  it("recognises email keys vs config/metadata keys", () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(repo.isEmailKey(fid("a.b.42"), "feed:a.b.42:config")).toBe(false);
    expect(repo.isEmailKey(fid("a.b.42"), "feed:a.b.42:metadata")).toBe(false);
    expect(repo.isEmailKey(fid("a.b.42"), "feed:a.b.42:1700000000000")).toBe(
      true,
    );
  });

  it("recovers the feed id from an email key", () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(repo.feedIdFromEmailKey("feed:a.b.42:1700000000000")).toBe("a.b.42");
  });
});

describe("FeedRepository inbound index", () => {
  const mbox = (v: string) => MailboxId.unchecked(v);

  it("resolves a mailbox to its feed id and back to null after delete", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.resolveInbound(mbox("river.castle.42"))).toBeNull();

    await repo.putInboundIndex(mbox("river.castle.42"), fid("opaque-id-1"));
    expect((await repo.resolveInbound(mbox("river.castle.42")))?.value).toBe(
      "opaque-id-1",
    );

    await repo.deleteInboundIndex(mbox("river.castle.42"));
    expect(await repo.resolveInbound(mbox("river.castle.42"))).toBeNull();
  });

  it("save() writes the inbound index from the aggregate's mailbox", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    await repo.save(
      Feed.reconstitute(
        fid("opaque-id-2"),
        {
          title: "T",
          language: "en",
          mailboxId: "lake.tower.77",
          allowedSenders: [],
          blockedSenders: [],
          createdAt: 1000,
        },
        { emails: [] },
      ),
    );
    expect((await repo.resolveInbound(mbox("lake.tower.77")))?.value).toBe(
      "opaque-id-2",
    );
  });
});

describe("FeedRepository config & metadata", () => {
  it("round-trips and deletes a feed config", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.getConfig(fid("a.b.42"))).toBeNull();
    await repo.putConfig(fid("a.b.42"), sampleConfig());
    expect(await repo.getConfig(fid("a.b.42"))).toMatchObject({
      title: "Test Feed",
    });
    await repo.deleteConfig(fid("a.b.42"));
    expect(await repo.getConfig(fid("a.b.42"))).toBeNull();
  });

  it("round-trips and deletes feed metadata", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    const meta: FeedMetadata = { emails: [] };
    await repo.putMetadata(fid("a.b.42"), meta);
    expect(await repo.getMetadata(fid("a.b.42"))).toEqual(meta);
    await repo.deleteMetadata(fid("a.b.42"));
    expect(await repo.getMetadata(fid("a.b.42"))).toBeNull();
  });
});

describe("FeedRepository emails", () => {
  it("stores and reads an email under a minted key", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    const key = repo.newEmailKey(fid("a.b.42"));
    await repo.putEmail(key, sampleEmail());
    expect(await repo.getEmail(key)).toMatchObject({ subject: "Hello" });
    await repo.deleteEmail(key);
    expect(await repo.getEmail(key)).toBeNull();
  });

  it("lists every key under a feed prefix", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    await repo.putConfig(fid("a.b.42"), sampleConfig());
    await repo.putMetadata(fid("a.b.42"), { emails: [] });
    const emailKey = repo.newEmailKey(fid("a.b.42"));
    await repo.putEmail(emailKey, sampleEmail());

    const listed = await repo.listFeedKeys(fid("a.b.42"));
    expect(listed.names).toContain("feed:a.b.42:config");
    expect(listed.names).toContain("feed:a.b.42:metadata");
    expect(listed.names).toContain(emailKey);
    expect(
      listed.names.filter((k) => repo.isEmailKey(fid("a.b.42"), k)),
    ).toEqual([emailKey]);
  });
});

describe("FeedRepository feed list", () => {
  const feedWith = (
    id: string,
    title: string,
    opts: { description?: string; expires_at?: number } = {},
  ) =>
    Feed.reconstitute(
      fid(id),
      {
        title,
        language: "en",
        mailboxId: `${id}.mbox`,
        allowedSenders: [],
        blockedSenders: [],
        createdAt: 1000,
        description: opts.description,
        expiresAt: opts.expires_at,
      },
      { emails: [] },
    );

  it("upserts the list entry from the aggregate on save/saveConfig", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    await repo.save(
      feedWith("a.b.42", "One", { description: "desc", expires_at: 5000 }),
    );
    await repo.save(feedWith("c.d.99", "Two"));

    let feeds = await repo.listFeeds();
    expect(feeds).toHaveLength(2);
    expect(feeds.find((f) => f.id === "a.b.42")).toMatchObject({
      title: "One",
      expires_at: 5000,
    });

    // saveConfig refreshes the same entry in place (no duplicate, expiry cleared).
    await repo.saveConfig(feedWith("a.b.42", "One-updated"));
    feeds = await repo.listFeeds();
    expect(feeds.filter((f) => f.id === "a.b.42")).toHaveLength(1);
    const updated = feeds.find((f) => f.id === "a.b.42");
    expect(updated).toMatchObject({ title: "One-updated" });
    expect(updated?.expires_at).toBeUndefined();

    expect(await repo.removeFromList(fid("a.b.42"))).toBe(true);
    expect(await repo.removeFromList(fid("missing"))).toBe(false);
    feeds = await repo.listFeeds();
    expect(feeds.map((f) => f.id)).toEqual(["c.d.99"]);
  });

  it("bulk-removes only the matching ids", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    await repo.save(feedWith("a.b.42", "One"));
    await repo.save(feedWith("c.d.99", "Two"));
    await repo.save(feedWith("e.f.10", "Three"));

    const removed = await repo.removeFromListBulk(["a.b.42", "e.f.10", "nope"]);
    expect(removed.sort()).toEqual(["a.b.42", "e.f.10"]);
    expect((await repo.listFeeds()).map((f) => f.id)).toEqual(["c.d.99"]);
  });

  it("drops each removed feed's inbound index (symmetric with save)", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    const mbox = (v: string) => MailboxId.unchecked(v);
    await repo.save(feedWith("a.b.42", "One"));
    await repo.save(feedWith("c.d.99", "Two"));

    // Both addresses resolve before removal.
    expect(await repo.resolveInbound(mbox("a.b.42.mbox"))).not.toBeNull();
    expect(await repo.resolveInbound(mbox("c.d.99.mbox"))).not.toBeNull();

    await repo.removeFromListBulk(["a.b.42"]);

    // The removed feed's address stops resolving; the survivor's still does.
    expect(await repo.resolveInbound(mbox("a.b.42.mbox"))).toBeNull();
    expect((await repo.resolveInbound(mbox("c.d.99.mbox")))?.value).toBe(
      "c.d.99",
    );
  });
});

describe("FeedRepository pendingConfirmation projection", () => {
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

  it("saveMetadata projects pendingConfirmation into feeds:list", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
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
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
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
