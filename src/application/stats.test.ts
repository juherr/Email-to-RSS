import { describe, it, expect } from "vitest";
import { createMockEnv, MockR2 } from "../test/setup";
import {
  getCounters,
  bumpCounters,
  countKeysByPrefix,
  getStats,
  scanR2Usage,
  scanKvUsage,
  setStorageSnapshot,
} from "./stats";
import { getAttachmentBucket } from "../infrastructure/attachments";
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
    await kv.put("websub:subs:a", "{}");
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

  it("getStats reports attachments_enabled based on the toggle", async () => {
    const off = createMockEnv() as unknown as Env;
    expect((await getStats(off)).attachments_enabled).toBe(false);

    const on = createMockEnv({ withR2: true }) as unknown as Env;
    expect((await getStats(on)).attachments_enabled).toBe(true);

    const disabled = createMockEnv({ withR2: true }) as unknown as Env;
    (disabled as any).ATTACHMENTS_ENABLED = "false";
    expect((await getStats(disabled)).attachments_enabled).toBe(false);
  });
});

describe("getAttachmentBucket", () => {
  it("returns the bucket when bound and not disabled", () => {
    const env = createMockEnv({ withR2: true }) as unknown as Env;
    expect(getAttachmentBucket(env)).toBeDefined();
  });

  it("returns undefined when no bucket is bound", () => {
    const env = createMockEnv() as unknown as Env;
    expect(getAttachmentBucket(env)).toBeUndefined();
  });

  it("returns undefined when explicitly disabled", () => {
    const env = createMockEnv({ withR2: true }) as unknown as Env;
    (env as any).ATTACHMENTS_ENABLED = "false";
    expect(getAttachmentBucket(env)).toBeUndefined();
  });
});

describe("storage usage scans", () => {
  it("scanR2Usage sums object sizes and counts", async () => {
    const bucket = new MockR2();
    await bucket.put("a", new Uint8Array(100));
    await bucket.put("b", new Uint8Array(250));
    const usage = await scanR2Usage(bucket as unknown as R2Bucket);
    expect(usage.count).toBe(2);
    expect(usage.bytes).toBe(350);
  });

  it("scanR2Usage returns zeros for an empty bucket", async () => {
    const usage = await scanR2Usage(new MockR2() as unknown as R2Bucket);
    expect(usage).toEqual({ bytes: 0, count: 0 });
  });

  it("scanKvUsage estimates KV bytes from stored email sizes", async () => {
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
    await kv.put(
      "feed:a:metadata",
      JSON.stringify({
        emails: [
          { key: "k1", size: 100 },
          { key: "k2", size: 50 },
        ],
      }),
    );
    await kv.put(
      "feed:b:metadata",
      JSON.stringify({ emails: [{ key: "k3", size: 25 }] }),
    );

    const usage = await scanKvUsage(kv);
    expect(usage.bytes).toBe(175);
  });

  it("setStorageSnapshot writes the snapshot fields", async () => {
    const env = createMockEnv() as unknown as Env;
    const kv = env.EMAIL_STORAGE;
    await setStorageSnapshot(kv, {
      attachments_bytes: 1234,
      attachments_count: 5,
      kv_bytes_estimated: 678,
    });
    const counters = await getCounters(kv);
    expect(counters.attachments_bytes).toBe(1234);
    expect(counters.attachments_count).toBe(5);
    expect(counters.kv_bytes_estimated).toBe(678);
    expect(counters.storage_scanned_at).toBeDefined();
  });
});
