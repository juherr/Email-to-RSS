import { describe, it, expect } from "vitest";
import worker from "./index";
import { APP_VERSION } from "./config/version";
import { createMockEnv } from "./test/setup";
import { createFeedRecord } from "./application/feed-service";
import { FeedRepository } from "./infrastructure/feed-repository";
import { FeedId } from "./domain/value-objects/feed-id";
import { MailboxId } from "./domain/value-objects/mailbox-id";
import type { Env } from "./types";

const env = createMockEnv();

const noopCtx = {
  waitUntil: () => {},
  passThroughOnException: () => {},
} as unknown as ExecutionContext;

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://test.getmynews.app${path}`, init);
}

describe("CORS middleware", () => {
  it("adds CORS headers for an allowed origin", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", { headers: { Origin: "https://kill-the.news" } }),
      env as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://kill-the.news",
    );
  });

  it("omits CORS headers for an unknown origin", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", { headers: { Origin: "https://evil.com" } }),
      env as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("handles OPTIONS preflight for an allowed origin with 204", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", {
        method: "OPTIONS",
        headers: {
          Origin: "https://kill-the.news",
          "Access-Control-Request-Method": "GET",
        },
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://kill-the.news",
    );
  });

  it("makes /api/v1/stats readable from any origin", async () => {
    const res = await worker.fetch(
      req("/api/v1/stats", { headers: { Origin: "https://example.com" } }),
      env as unknown as Env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("scheduled (cron) TTL cleanup", () => {
  it("drops the inbound mailbox index when an expired feed is purged", async () => {
    const cronEnv = createMockEnv() as unknown as Env;
    const { feedId, mailboxId } = await createFeedRecord(cronEnv, {
      title: "Expiring",
      language: "en",
      allowedSenders: [],
      blockedSenders: [],
    });
    const repo = FeedRepository.from(cronEnv);

    // The address resolves to the feed before the cron runs.
    expect(
      (await repo.resolveInbound(MailboxId.unchecked(mailboxId)))?.value,
    ).toBe(feedId);

    // Backdate the feed so the cron treats it as expired.
    const list = (await cronEnv.EMAIL_STORAGE.get("feeds:list", "json")) as {
      feeds: Array<{ id: string; expires_at?: number; mailbox_id?: string }>;
    };
    list.feeds[0].expires_at = Date.now() - 1000;
    await cronEnv.EMAIL_STORAGE.put("feeds:list", JSON.stringify(list));

    await worker.scheduled({} as ScheduledEvent, cronEnv, noopCtx);

    // The feed is gone AND its inbound address no longer resolves.
    expect(await repo.getConfig(FeedId.unchecked(feedId))).toBeNull();
    expect(
      await repo.resolveInbound(MailboxId.unchecked(mailboxId)),
    ).toBeNull();
  });
});

describe("GET /health", () => {
  it("reports status ok and the bundled app version", async () => {
    const res = await worker.fetch(req("/health"), env as unknown as Env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
    expect(body.version).toBe(APP_VERSION);
    expect(body.version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("GET /robots.txt", () => {
  it("returns 200 and disallows the private feed/entry paths", async () => {
    const res = await worker.fetch(req("/robots.txt"), env as unknown as Env);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("User-agent: *");
    expect(body).toContain("Disallow: /rss/");
    expect(body).toContain("Disallow: /atom/");
    expect(body).toContain("Disallow: /entries/");
    expect(body).toContain("Disallow: /files/");
    expect(body).toContain("Disallow: /admin/");
  });
});
