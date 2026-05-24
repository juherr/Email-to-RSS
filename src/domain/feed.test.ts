import { describe, it, expect } from "vitest";
import {
  resolveExpiresAt,
  isExpired,
  applySenderPolicy,
  trimToByteBudget,
} from "./feed";
import type { FeedMetadata, EmailMetadata } from "../types";

describe("resolveExpiresAt", () => {
  const NOW = 1_000_000;

  it("returns undefined when no positive lifetime applies", () => {
    expect(resolveExpiresAt(undefined, NOW)).toBeUndefined();
    expect(resolveExpiresAt(0, NOW)).toBeUndefined();
    expect(resolveExpiresAt(-5, NOW)).toBeUndefined();
    expect(resolveExpiresAt(NaN, NOW)).toBeUndefined();
  });

  it("computes expiry from a supplied lifetime relative to now", () => {
    expect(resolveExpiresAt(2, NOW)).toBe(NOW + 2 * 3_600_000);
  });
});

describe("isExpired", () => {
  it("is false when no expiry is set", () => {
    expect(isExpired({ expires_at: undefined }, 1000)).toBe(false);
  });

  it("is true at or past the expiry instant", () => {
    expect(isExpired({ expires_at: 1000 }, 1000)).toBe(true);
    expect(isExpired({ expires_at: 1000 }, 1001)).toBe(true);
    expect(isExpired({ expires_at: 1000 }, 999)).toBe(false);
  });
});

describe("applySenderPolicy", () => {
  it("accepts everything when no lists are configured", () => {
    expect(applySenderPolicy({}, ["anyone@example.com"])).toBe("accepted");
  });

  it("requires an allowlist match when an allowlist is set", () => {
    const config = { allowed_senders: ["news@example.com"] };
    expect(applySenderPolicy(config, ["news@example.com"])).toBe("accepted");
    expect(applySenderPolicy(config, ["other@example.com"])).toBe("blocked");
  });

  it("matches an allowlist by domain", () => {
    const config = { allowed_senders: ["example.com"] };
    expect(applySenderPolicy(config, ["anyone@example.com"])).toBe("accepted");
  });

  it("blocks a blocklisted sender even when allowlisted", () => {
    const config = {
      allowed_senders: ["example.com"],
      blocked_senders: ["spam@example.com"],
    };
    expect(applySenderPolicy(config, ["spam@example.com"])).toBe("blocked");
    expect(applySenderPolicy(config, ["ok@example.com"])).toBe("accepted");
  });

  it("with only a blocklist, accepts everything else", () => {
    const config = { blocked_senders: ["bad.com"] };
    expect(applySenderPolicy(config, ["x@bad.com"])).toBe("blocked");
    expect(applySenderPolicy(config, ["x@good.com"])).toBe("accepted");
  });
});

describe("trimToByteBudget", () => {
  const entry = (key: string, size: number): EmailMetadata => ({
    key,
    subject: key,
    receivedAt: 1,
    size,
  });

  it("keeps everything within budget", () => {
    const meta: FeedMetadata = { emails: [entry("a", 10), entry("b", 10)] };
    const { dropped } = trimToByteBudget(meta, 100);
    expect(dropped).toEqual([]);
    expect(meta.emails).toHaveLength(2);
  });

  it("drops the oldest entries (from the tail) until within budget", () => {
    const meta: FeedMetadata = {
      emails: [entry("new", 30), entry("mid", 30), entry("old", 30)],
    };
    const { dropped } = trimToByteBudget(meta, 50);
    expect(dropped.map((e) => e.key)).toEqual(["old", "mid"]);
    expect(meta.emails.map((e) => e.key)).toEqual(["new"]);
  });

  it("always keeps at least one entry, even when oversized", () => {
    const meta: FeedMetadata = { emails: [entry("only", 999)] };
    const { dropped } = trimToByteBudget(meta, 1);
    expect(dropped).toEqual([]);
    expect(meta.emails).toHaveLength(1);
  });
});
