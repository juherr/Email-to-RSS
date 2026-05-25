import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { handle } from "./json";
import { createMockEnv } from "../test/setup";
import { Env } from "../types";

describe("JSON Feed Route", () => {
  let testApp: Hono;
  let mockEnv: Env;

  beforeEach(() => {
    mockEnv = createMockEnv() as unknown as Env;
    testApp = new Hono();
    testApp.get("/:feedId", handle);
  });

  describe("unknown feed", () => {
    it("returns 404 when no metadata exists in KV", async () => {
      const res = await testApp.request("/nonexistent-feed", {}, mockEnv);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("Feed not found");
    });
  });

  describe("valid feed with no emails", () => {
    beforeEach(async () => {
      await mockEnv.EMAIL_STORAGE.put(
        "feed:empty-feed:metadata",
        JSON.stringify({ emails: [] }),
      );
    });

    it("returns 200 with application/feed+json content type", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain(
        "application/feed+json",
      );
    });

    it("includes Cache-Control header", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("Cache-Control")).toBe("max-age=1800");
    });

    it("sets X-Robots-Tag: noindex", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });

    it("Link header advertises hub and self", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      const link = res.headers.get("Link") ?? "";
      expect(link).toContain(`rel="hub"`);
      expect(link).toContain(
        `<https://${mockEnv.DOMAIN}/json/empty-feed>; rel="self"`,
      );
    });

    it("body parses as JSON with jsonfeed version 1.1", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      const body = (await res.json()) as { version: string; items: unknown[] };
      expect(body.version).toBe("https://jsonfeed.org/version/1");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items).toHaveLength(0);
    });
  });

  describe("valid feed with emails", () => {
    const FEED_ID = "test-feed-json";
    const EMAIL_RECEIVED_AT = 1700000001000;

    beforeEach(async () => {
      const emailKey = `feed:${FEED_ID}:${EMAIL_RECEIVED_AT}`;
      await mockEnv.EMAIL_STORAGE.put(
        emailKey,
        JSON.stringify({
          subject: "JSON Feed Subject",
          from: "Sender <sender@example.com>",
          content: "<p>Body content</p>",
          receivedAt: EMAIL_RECEIVED_AT,
          headers: {},
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:metadata`,
        JSON.stringify({
          emails: [
            {
              key: emailKey,
              subject: "JSON Feed Subject",
              receivedAt: EMAIL_RECEIVED_AT,
            },
          ],
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:config`,
        JSON.stringify({
          title: "My JSON Feed",
          language: "en",
          created_at: 1700000000000,
        }),
      );
    });

    it("returns 200 with items containing the seeded email", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        version: string;
        items: Array<{ title: string }>;
      };
      expect(body.version).toBe("https://jsonfeed.org/version/1");
      expect(Array.isArray(body.items)).toBe(true);
      expect(body.items).toHaveLength(1);
      expect(body.items[0].title).toBe("JSON Feed Subject");
    });
  });

  describe("expired feed", () => {
    beforeEach(async () => {
      const pastTimestamp = Date.now() - 1000 * 60 * 60 * 24; // 1 day ago
      await mockEnv.EMAIL_STORAGE.put(
        "feed:expired-feed:metadata",
        JSON.stringify({ emails: [] }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        "feed:expired-feed:config",
        JSON.stringify({
          title: "Expired Feed",
          language: "en",
          created_at: pastTimestamp,
          expires_at: pastTimestamp,
        }),
      );
    });

    it("returns 410 for expired feed", async () => {
      const res = await testApp.request("/expired-feed", {}, mockEnv);
      expect(res.status).toBe(410);
      expect(await res.text()).toBe("Feed has expired");
    });
  });
});
