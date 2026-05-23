import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { FeedRepository } from "./feed-repository";
import { FeedId } from "./value-objects/feed-id";
import type { Env, FeedConfig, FeedMetadata, EmailData } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;
const fid = (value: string) => FeedId.fromTrusted(value);

const sampleConfig = (overrides: Partial<FeedConfig> = {}): FeedConfig => ({
  title: "Test Feed",
  language: "en",
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
  it("adds, updates, lists and removes feeds with expiry", async () => {
    const repo = new FeedRepository(mockEnv().EMAIL_STORAGE);
    await repo.addToList(fid("a.b.42"), "One", "desc", 5000);
    await repo.addToList(fid("c.d.99"), "Two");

    let feeds = await repo.listFeeds();
    expect(feeds).toHaveLength(2);
    expect(feeds.find((f) => f.id === "a.b.42")).toMatchObject({
      title: "One",
      expires_at: 5000,
    });

    await repo.updateInList(fid("a.b.42"), "One-updated", undefined, undefined);
    feeds = await repo.listFeeds();
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
    await repo.addToList(fid("a.b.42"), "One");
    await repo.addToList(fid("c.d.99"), "Two");
    await repo.addToList(fid("e.f.10"), "Three");

    const removed = await repo.removeFromListBulk(["a.b.42", "e.f.10", "nope"]);
    expect(removed.sort()).toEqual(["a.b.42", "e.f.10"]);
    expect((await repo.listFeeds()).map((f) => f.id)).toEqual(["c.d.99"]);
  });
});
