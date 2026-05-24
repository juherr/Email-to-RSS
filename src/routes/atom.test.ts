import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { handle } from "./atom";
import { createMockEnv } from "../test/setup";
import { Env } from "../types";

describe("Atom Feed Route", () => {
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

    it("returns 200 with application/atom+xml content type", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/atom+xml");
    });

    it("returns valid Atom XML with no <entry> elements", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      const body = await res.text();
      expect(body).toContain('xmlns="http://www.w3.org/2005/Atom"');
      expect(body).not.toContain("<entry>");
    });

    it("includes Cache-Control header", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("Cache-Control")).toBe("max-age=1800");
    });

    it("sets X-Robots-Tag: noindex", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });
  });

  describe("valid feed with emails", () => {
    const FEED_ID = "test-feed-atom";

    beforeEach(async () => {
      const emailKey = `feed:${FEED_ID}:1700000001000`;
      await mockEnv.EMAIL_STORAGE.put(
        emailKey,
        JSON.stringify({
          subject: "Atom Entry Subject",
          from: "Sender <sender@example.com>",
          content: "<p>Email body</p>",
          receivedAt: 1700000001000,
          headers: {},
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:metadata`,
        JSON.stringify({
          emails: [
            {
              key: emailKey,
              subject: "Atom Entry Subject",
              receivedAt: 1700000001000,
            },
          ],
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:config`,
        JSON.stringify({
          title: "Atom Test Feed",
          description: "Integration test",
          language: "en",
          created_at: 1700000000000,
        }),
      );
    });

    it("returns 200 with application/atom+xml", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/atom+xml");
    });

    it("contains Atom namespace declaration", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const body = await res.text();
      expect(body).toContain('xmlns="http://www.w3.org/2005/Atom"');
    });

    it("contains <entry> for the email", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const body = await res.text();
      expect(body).toContain("<entry>");
      expect(body).toContain("Atom Entry Subject");
    });

    it("contains feed title", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const body = await res.text();
      expect(body).toContain("Atom Test Feed");
    });

    it("self-link points to atom URL", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const body = await res.text();
      expect(body).toContain(`/atom/${FEED_ID}`);
    });

    it("Link header advertises hub and self for WebSub discovery", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const link = res.headers.get("Link") ?? "";
      expect(link).toContain(`rel="hub"`);
      expect(link).toContain(`/atom/${FEED_ID}`);
      expect(link).toContain(`rel="self"`);
    });
  });

  describe("fallback config when no config in KV", () => {
    it("uses atom path in fallback and returns 200", async () => {
      await mockEnv.EMAIL_STORAGE.put(
        "feed:no-config-feed:metadata",
        JSON.stringify({ emails: [] }),
      );
      const res = await testApp.request("/no-config-feed", {}, mockEnv);
      expect(res.status).toBe(200);
      const body = await res.text();
      expect(body).toContain('xmlns="http://www.w3.org/2005/Atom"');
    });
  });
});
