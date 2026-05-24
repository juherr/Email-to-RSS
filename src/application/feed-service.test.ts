import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { createFeedRecord, editFeed } from "./feed-service";
import { getCounters } from "./stats";
import { FeedId } from "../domain/value-objects/feed-id";
import type { Env } from "../types";

const mkEnv = (overrides: Partial<Env> = {}) =>
  ({ ...createMockEnv(), ...overrides }) as unknown as Env;

const baseInput = {
  title: "N",
  language: "en",
  allowedSenders: [],
  blockedSenders: [],
};

const TWO_HOURS = 2 * 3_600_000;

// The lifetime policy (parse env, apply the server-side FEED_TTL_HOURS override)
// lives here in the application layer; the domain only receives a resolved
// ttlHours. These tests pin that policy at the public service boundary.
describe("createFeedRecord — TTL policy", () => {
  it("never expires when neither server nor client lifetime is set", async () => {
    const { config } = await createFeedRecord(mkEnv(), { ...baseInput });
    expect(config.expires_at).toBeUndefined();
  });

  it("uses the client lifetimeHours when there is no server override", async () => {
    const before = Date.now();
    const { config } = await createFeedRecord(mkEnv(), {
      ...baseInput,
      lifetimeHours: 2,
    });
    expect(config.expires_at!).toBeGreaterThanOrEqual(before + TWO_HOURS);
  });

  it("lets a server FEED_TTL_HOURS override a larger client lifetime", async () => {
    const before = Date.now();
    const { config } = await createFeedRecord(mkEnv({ FEED_TTL_HOURS: "1" }), {
      ...baseInput,
      lifetimeHours: 9999,
    });
    // 1h (server) wins over 9999h (client).
    expect(config.expires_at!).toBeLessThan(before + TWO_HOURS);
  });

  it("bumps the feeds_created counter via the FeedCreated domain event", async () => {
    const env = mkEnv();
    await createFeedRecord(env, { ...baseInput });
    const counters = await getCounters(env.EMAIL_STORAGE);
    expect(counters.feeds_created).toBe(1);
    expect(counters.last_feed_created_at).toBeDefined();
  });
});

describe("editFeed — TTL policy", () => {
  it("recomputes expiry from the server override on edit", async () => {
    const env = mkEnv({ FEED_TTL_HOURS: "1" });
    const { feedId } = await createFeedRecord(env, { ...baseInput });

    const before = Date.now();
    const result = await editFeed(env, FeedId.unchecked(feedId), {
      title: "renamed",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config.title).toBe("renamed");
      expect(result.config.expires_at!).toBeLessThan(before + TWO_HOURS);
    }
  });

  it("preserves expiry when neither server TTL nor client lifetime is given", async () => {
    const env = mkEnv();
    const { feedId, config } = await createFeedRecord(env, {
      ...baseInput,
      lifetimeHours: 5,
    });

    const result = await editFeed(env, FeedId.unchecked(feedId), {
      title: "x",
    });

    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.config.expires_at).toBe(config.expires_at);
    }
  });
});
