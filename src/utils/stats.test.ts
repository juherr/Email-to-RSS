import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import {
  getCounters,
  bumpCounters,
  countKeysByPrefix,
  getStats,
} from "./stats";
import { STATS_KEY, FEEDS_LIST_KEY } from "../config/constants";
import { Env } from "../types";

describe("stats helper", () => {
  it("returns zeroed counters when nothing is stored", async () => {
    const env = createMockEnv() as unknown as Env;
    const counters = await getCounters(env.EMAIL_STORAGE);
    expect(counters).toMatchObject({
      feeds_created: 0,
      feeds_deleted: 0,
      emails_received: 0,
      emails_rejected: 0,
    });
    expect(counters.first_seen).toBeUndefined();
  });

  it("accumulates numeric deltas across bumps", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;

    await bumpCounters(kv, { emails_received: 1 });
    await bumpCounters(kv, { emails_received: 2, emails_rejected: 1 });
    await bumpCounters(kv, { feeds_created: 1, feeds_deleted: 3 });

    const counters = await getCounters(kv);
    expect(counters.emails_received).toBe(3);
    expect(counters.emails_rejected).toBe(1);
    expect(counters.feeds_created).toBe(1);
    expect(counters.feeds_deleted).toBe(3);
  });

  it("overwrites date-time fields and sets first_seen once", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;

    await bumpCounters(kv, {
      emails_received: 1,
      last_email_at: "2026-01-01T00:00:00.000Z",
    });
    const first = await getCounters(kv);
    const firstSeen = first.first_seen;
    expect(firstSeen).toBeDefined();
    expect(first.last_email_at).toBe("2026-01-01T00:00:00.000Z");

    await bumpCounters(kv, {
      emails_received: 1,
      last_email_at: "2026-02-02T00:00:00.000Z",
    });
    const second = await getCounters(kv);
    expect(second.last_email_at).toBe("2026-02-02T00:00:00.000Z");
    expect(second.first_seen).toBe(firstSeen);
  });

  it("counts keys by prefix", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;
    await kv.put("websub:a:1", "{}");
    await kv.put("websub:a:2", "{}");
    await kv.put("feed:x:config", "{}");

    expect(await countKeysByPrefix(kv, "websub:")).toBe(2);
    expect(await countKeysByPrefix(kv, "missing:")).toBe(0);
  });

  it("getStats combines persisted counters with live values", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;

    await kv.put(
      FEEDS_LIST_KEY,
      JSON.stringify({
        feeds: [
          { id: "a", title: "A" },
          { id: "b", title: "B" },
        ],
      }),
    );
    await kv.put("websub:a:1", "{}");
    await bumpCounters(kv, { emails_received: 5, feeds_created: 2 });

    const stats = await getStats(env);
    expect(stats.active_feeds).toBe(2);
    expect(stats.websub_subscriptions_active).toBe(1);
    expect(stats.emails_received).toBe(5);
    expect(stats.feeds_created).toBe(2);
  });

  it("never throws on a failing KV (counters are best-effort)", async () => {
    const brokenKv = {
      get: async () => {
        throw new Error("kv down");
      },
      put: async () => {
        throw new Error("kv down");
      },
    } as unknown as KVNamespace;

    await expect(
      bumpCounters(brokenKv, { emails_received: 1 }),
    ).resolves.toBeUndefined();
    expect(await getCounters(brokenKv)).toMatchObject({ emails_received: 0 });
    expect(await countKeysByPrefix(brokenKv, "websub:")).toBe(0);
  });

  it("persists under the stats KV key", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;
    await bumpCounters(kv, { feeds_created: 1 });
    const raw = (await kv.get(STATS_KEY, { type: "json" })) as {
      feeds_created: number;
    };
    expect(raw.feeds_created).toBe(1);
  });
});
