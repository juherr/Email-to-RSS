import { describe, it, expect } from "vitest";
import worker from "../index";
import { createMockEnv } from "../test/setup";
import { bumpCounters } from "../utils/stats";
import { FEEDS_LIST_KEY } from "../config/constants";
import type { Env, StatsResponse } from "../types";

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://test.getmynews.app${path}`, init);
}

describe("GET /api/stats", () => {
  it("returns zeroed stats for a fresh instance", async () => {
    const env = createMockEnv() as unknown as Env;
    const res = await worker.fetch(req("/api/stats"), env);
    expect(res.status).toBe(200);
    const body = (await res.json()) as StatsResponse;
    expect(body).toMatchObject({
      feeds_created: 0,
      feeds_deleted: 0,
      emails_received: 0,
      emails_rejected: 0,
      active_feeds: 0,
      websub_subscriptions_active: 0,
    });
  });

  it("reflects persisted counters and live values", async () => {
    const env = createMockEnv() as unknown as Env;
    await env.EMAIL_STORAGE.put(
      FEEDS_LIST_KEY,
      JSON.stringify({ feeds: [{ id: "a", title: "A" }] }),
    );
    await env.EMAIL_STORAGE.put("websub:a:hash", "{}");
    await bumpCounters(env.EMAIL_STORAGE, {
      emails_received: 3,
      emails_rejected: 1,
      feeds_created: 1,
    });

    const res = await worker.fetch(req("/api/stats"), env);
    const body = (await res.json()) as StatsResponse;
    expect(body.active_feeds).toBe(1);
    expect(body.websub_subscriptions_active).toBe(1);
    expect(body.emails_received).toBe(3);
    expect(body.emails_rejected).toBe(1);
    expect(body.feeds_created).toBe(1);
  });
});

describe("GET / (public status page)", () => {
  it("returns an HTML status page with counters and an admin link", async () => {
    const env = createMockEnv() as unknown as Env;
    await bumpCounters(env.EMAIL_STORAGE, { emails_received: 7 });

    const res = await worker.fetch(req("/"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");

    const html = await res.text();
    expect(html).toContain('href="/admin"');
    expect(html).toContain("Active feeds");
    expect(html).toContain("Emails received");
    expect(html).toContain("7");
  });
});
