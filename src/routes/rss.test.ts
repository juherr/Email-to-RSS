import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { handle } from "./rss";
import { createMockEnv } from "../test/setup";
import { Env } from "../types";

describe("RSS Feed Route", () => {
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

    it("returns 200 with application/rss+xml content type", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("application/rss+xml");
    });

    it("includes Cache-Control header", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("Cache-Control")).toBe("max-age=1800");
    });

    it("sets X-Robots-Tag: noindex", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
    });

    it("Link header advertises hub and self for WebSub discovery", async () => {
      const res = await testApp.request("/empty-feed", {}, mockEnv);
      const link = res.headers.get("Link") ?? "";
      expect(link).toContain(`rel="hub"`);
      expect(link).toContain(`rel="self"`);
    });
  });
});
