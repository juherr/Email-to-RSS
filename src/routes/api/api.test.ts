import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { apiApp } from "./index";
import { createMockEnv } from "../../test/setup";
import { Env } from "../../types";
import { FeedRepository } from "../../infrastructure/feed-repository";
import { FeedId } from "../../domain/value-objects/feed-id";

const PASSWORD = "test-password";
const authHeaders = { Authorization: `Bearer ${PASSWORD}` };

describe("REST API (/api/v1)", () => {
  let testApp: Hono;
  let mockEnv: Env;
  let request: (path: string, init?: RequestInit) => Promise<Response>;

  beforeEach(() => {
    mockEnv = createMockEnv() as unknown as Env;
    testApp = new Hono();
    testApp.route("/api", apiApp);
    request = (path, init = {}) =>
      Promise.resolve(testApp.request(path, init, mockEnv));
  });

  async function createFeed(title = "Test Feed"): Promise<string> {
    const res = await request("/api/v1/feeds", {
      method: "POST",
      headers: { ...authHeaders, "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string };
    return body.id;
  }

  describe("Authentication", () => {
    it("rejects requests without a token", async () => {
      const res = await request("/api/v1/feeds");
      expect(res.status).toBe(401);
      expect((await res.json()) as { error: string }).toEqual({
        error: "Unauthorized",
      });
    });

    it("rejects requests with a wrong token", async () => {
      const res = await request("/api/v1/feeds", {
        headers: { Authorization: "Bearer nope" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts a valid Bearer token", async () => {
      const res = await request("/api/v1/feeds", { headers: authHeaders });
      expect(res.status).toBe(200);
    });

    it("accepts proxy auth headers", async () => {
      const proxyApp = new Hono();
      proxyApp.route("/api", apiApp);
      const proxyEnv = {
        ...createMockEnv(),
        PROXY_TRUSTED_IPS: "10.0.0.1",
        PROXY_AUTH_SECRET: "proxy-secret",
      } as unknown as Env;
      const res = await proxyApp.request(
        "/api/v1/feeds",
        {
          headers: {
            "CF-Connecting-IP": "10.0.0.1",
            "X-Auth-Proxy-Secret": "proxy-secret",
            "Remote-User": "alice",
          },
        },
        proxyEnv,
      );
      expect(res.status).toBe(200);
    });
  });

  describe("Feeds CRUD", () => {
    it("creates, reads, lists, updates and deletes a feed", async () => {
      // Create
      const createRes = await request("/api/v1/feeds", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({
          title: "Daily Digest",
          description: "news",
          allowedSenders: ["News@Example.com"],
        }),
      });
      expect(createRes.status).toBe(201);
      const created = (await createRes.json()) as {
        id: string;
        title: string;
        allowedSenders: string[];
        emailAddress: string;
        rssUrl: string;
        atomUrl: string;
        emailCount: number;
      };
      expect(created.title).toBe("Daily Digest");
      // senders are normalized to lowercase
      expect(created.allowedSenders).toEqual(["news@example.com"]);
      expect(created.emailCount).toBe(0);
      expect(created.rssUrl).toContain(`/rss/${created.id}`);

      // Get
      const getRes = await request(`/api/v1/feeds/${created.id}`, {
        headers: authHeaders,
      });
      expect(getRes.status).toBe(200);
      expect((await getRes.json()) as { id: string }).toMatchObject({
        id: created.id,
        title: "Daily Digest",
      });

      // List
      const listRes = await request("/api/v1/feeds", { headers: authHeaders });
      const list = (await listRes.json()) as { feeds: { id: string }[] };
      expect(list.feeds.map((f) => f.id)).toContain(created.id);

      // Update
      const patchRes = await request(`/api/v1/feeds/${created.id}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Renamed" }),
      });
      expect(patchRes.status).toBe(200);
      expect((await patchRes.json()) as { title: string }).toMatchObject({
        title: "Renamed",
      });

      // Delete
      const delRes = await request(`/api/v1/feeds/${created.id}`, {
        method: "DELETE",
        headers: authHeaders,
      });
      expect(delRes.status).toBe(200);
      expect((await delRes.json()) as { ok: boolean }).toEqual({ ok: true });

      // Gone from the list
      const after = await request("/api/v1/feeds", { headers: authHeaders });
      const afterList = (await after.json()) as { feeds: { id: string }[] };
      expect(afterList.feeds.map((f) => f.id)).not.toContain(created.id);
    });

    it("defaults senderInTitle to false and lets it be set on create and update", async () => {
      const createRes = await request("/api/v1/feeds", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Title Feed" }),
      });
      const created = (await createRes.json()) as {
        id: string;
        senderInTitle: boolean;
      };
      expect(created.senderInTitle).toBe(false);

      const setRes = await request("/api/v1/feeds", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Prefixed Feed", senderInTitle: true }),
      });
      const set = (await setRes.json()) as {
        id: string;
        senderInTitle: boolean;
      };
      expect(set.senderInTitle).toBe(true);

      const patchRes = await request(`/api/v1/feeds/${set.id}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ senderInTitle: false }),
      });
      expect(patchRes.status).toBe(200);
      expect(
        (await patchRes.json()) as { senderInTitle: boolean },
      ).toMatchObject({ senderInTitle: false });
    });

    it("returns 400 for an invalid create body", async () => {
      const res = await request("/api/v1/feeds", {
        method: "POST",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "" }),
      });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toHaveProperty("error");
    });

    it("returns 404 when getting a missing feed", async () => {
      const res = await request("/api/v1/feeds/does-not-exist", {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when deleting a missing feed", async () => {
      const res = await request("/api/v1/feeds/does-not-exist", {
        method: "DELETE",
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });

    it("returns 404 when updating a missing feed", async () => {
      const res = await request("/api/v1/feeds/does-not-exist", {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "x" }),
      });
      expect(res.status).toBe(404);
    });
  });

  describe("nativeFeeds field", () => {
    it("returns nativeFeeds as empty array for a brand-new feed", async () => {
      const feedId = await createFeed("Native Feed Test");
      const res = await request(`/api/v1/feeds/${feedId}`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nativeFeeds: unknown };
      expect(body.nativeFeeds).toEqual([]);
    });

    it("returns nativeFeeds populated when the feed metadata has native feeds", async () => {
      const feedId = await createFeed("Native Feed With Data");
      const id = FeedId.unchecked(feedId);
      const repo = FeedRepository.from(mockEnv);
      const feed = await repo.load(id);
      expect(feed).not.toBeNull();
      const receivedAt = Date.now();
      feed!.ingest(
        {
          key: `feed:${feedId}:email:${receivedAt}`,
          subject: "Newsletter",
          receivedAt,
        },
        {
          maxBytes: 1e9,
          nativeFeeds: {
            senderKey: "author@blog.example.com",
            feeds: [{ url: "https://blog.example.com/feed.xml", type: "rss" }],
          },
        },
      );
      await repo.save(feed!);

      const res = await request(`/api/v1/feeds/${feedId}`, {
        headers: authHeaders,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        nativeFeeds: { url: string; type: string }[];
      };
      expect(body.nativeFeeds).toEqual([
        { url: "https://blog.example.com/feed.xml", type: "rss" },
      ]);
    });

    it("PATCH response also includes nativeFeeds", async () => {
      const feedId = await createFeed("Patch Native Feed Test");
      const res = await request(`/api/v1/feeds/${feedId}`, {
        method: "PATCH",
        headers: { ...authHeaders, "Content-Type": "application/json" },
        body: JSON.stringify({ title: "Updated Title" }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { nativeFeeds: unknown };
      expect(body.nativeFeeds).toEqual([]);
    });
  });

  describe("Emails", () => {
    it("lists, reads and deletes an email", async () => {
      const feedId = await createFeed();

      // Seed an email directly into KV (mirrors storeEmail's key shape).
      const receivedAt = 1737000000000;
      const key = `feed:${feedId}:email:${receivedAt}`;
      await mockEnv.EMAIL_STORAGE.put(
        key,
        JSON.stringify({
          subject: "Hello",
          from: "news@example.com",
          content: "<p>hi</p>",
          receivedAt,
          headers: {},
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${feedId}:metadata`,
        JSON.stringify({
          emails: [{ key, subject: "Hello", receivedAt }],
        }),
      );

      // List
      const listRes = await request(`/api/v1/feeds/${feedId}/emails`, {
        headers: authHeaders,
      });
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as {
        emails: { entryId: number; subject: string }[];
      };
      expect(list.emails).toHaveLength(1);
      expect(list.emails[0]).toMatchObject({
        entryId: receivedAt,
        subject: "Hello",
      });

      // Get single
      const getRes = await request(
        `/api/v1/feeds/${feedId}/emails/${receivedAt}`,
        { headers: authHeaders },
      );
      expect(getRes.status).toBe(200);
      expect((await getRes.json()) as { content: string }).toMatchObject({
        from: "news@example.com",
        content: "<p>hi</p>",
      });

      // Delete
      const delRes = await request(
        `/api/v1/feeds/${feedId}/emails/${receivedAt}`,
        { method: "DELETE", headers: authHeaders },
      );
      expect(delRes.status).toBe(200);
      expect(await mockEnv.EMAIL_STORAGE.get(key)).toBeNull();

      // Gone
      const after = await request(
        `/api/v1/feeds/${feedId}/emails/${receivedAt}`,
        { headers: authHeaders },
      );
      expect(after.status).toBe(404);
    });

    it("returns 404 listing emails for a missing feed", async () => {
      const res = await request("/api/v1/feeds/missing/emails", {
        headers: authHeaders,
      });
      expect(res.status).toBe(404);
    });
  });

  describe("Stats", () => {
    it("returns monitoring counters without a token (public)", async () => {
      await createFeed();
      const res = await request("/api/v1/stats");
      expect(res.status).toBe(200);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
      const stats = (await res.json()) as {
        feeds_created: number;
        active_feeds: number;
        attachments_enabled: boolean;
        version: string;
      };
      expect(stats.feeds_created).toBeGreaterThanOrEqual(1);
      expect(stats.active_feeds).toBeGreaterThanOrEqual(1);
      expect(typeof stats.attachments_enabled).toBe("boolean");
      expect(stats.version).toMatch(/^\d+\.\d+\.\d+/);
    });
  });

  describe("OpenAPI document", () => {
    it("serves a public OpenAPI 3.1 spec", async () => {
      const res = await request("/api/openapi.json");
      expect(res.status).toBe(200);
      const doc = (await res.json()) as {
        openapi: string;
        paths: Record<string, { get?: { security?: unknown[] } }>;
      };
      expect(doc.openapi).toBe("3.1.0");
      expect(doc.paths).toHaveProperty("/v1/feeds");
      expect(doc.paths).toHaveProperty("/v1/feeds/{feedId}");
      expect(doc.paths).toHaveProperty("/v1/stats");
      // Feed routes are secured; stats is public.
      expect(doc.paths["/v1/feeds"].get?.security).toBeTruthy();
      expect(doc.paths["/v1/stats"].get?.security).toBeUndefined();
    });
  });
});
