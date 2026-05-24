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

  describe("conditional GET (ETag + Last-Modified)", () => {
    const FEED_ID = "test-feed-rss-cget";
    const EMAIL_RECEIVED_AT = 1700000001000;

    beforeEach(async () => {
      const emailKey = `feed:${FEED_ID}:${EMAIL_RECEIVED_AT}`;
      await mockEnv.EMAIL_STORAGE.put(
        emailKey,
        JSON.stringify({
          subject: "RSS Subject",
          from: "Sender <sender@example.com>",
          content: "<p>Body</p>",
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
              subject: "RSS Subject",
              receivedAt: EMAIL_RECEIVED_AT,
            },
          ],
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:config`,
        JSON.stringify({
          title: "RSS Cget Feed",
          language: "en",
          created_at: 1700000000000,
        }),
      );
    });

    it("first GET returns 200 with ETag and Last-Modified headers", async () => {
      const res = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBeTruthy();
      expect(res.headers.get("Last-Modified")).toBeTruthy();
    });

    it("GET with matching If-None-Match returns 304 with empty body", async () => {
      const first = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const etag = first.headers.get("ETag")!;

      const res = await testApp.request(
        `/${FEED_ID}`,
        { headers: { "If-None-Match": etag } },
        mockEnv,
      );
      expect(res.status).toBe(304);
      expect(await res.text()).toBe("");
    });

    it("GET with If-Modified-Since in the future returns 304", async () => {
      const future = new Date(EMAIL_RECEIVED_AT + 1000).toUTCString();
      const res = await testApp.request(
        `/${FEED_ID}`,
        { headers: { "If-Modified-Since": future } },
        mockEnv,
      );
      expect(res.status).toBe(304);
    });

    it("stale If-None-Match after new email results in 200", async () => {
      // Get ETag before new email
      const first = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const oldEtag = first.headers.get("ETag")!;

      // Add a newer email
      const newReceivedAt = EMAIL_RECEIVED_AT + 5000;
      const newEmailKey = `feed:${FEED_ID}:${newReceivedAt}`;
      await mockEnv.EMAIL_STORAGE.put(
        newEmailKey,
        JSON.stringify({
          subject: "Newer Email",
          from: "Sender <sender@example.com>",
          content: "<p>New body</p>",
          receivedAt: newReceivedAt,
          headers: {},
        }),
      );
      await mockEnv.EMAIL_STORAGE.put(
        `feed:${FEED_ID}:metadata`,
        JSON.stringify({
          emails: [
            {
              key: newEmailKey,
              subject: "Newer Email",
              receivedAt: newReceivedAt,
            },
            {
              key: `feed:${FEED_ID}:${EMAIL_RECEIVED_AT}`,
              subject: "RSS Subject",
              receivedAt: EMAIL_RECEIVED_AT,
            },
          ],
        }),
      );

      const res = await testApp.request(
        `/${FEED_ID}`,
        { headers: { "If-None-Match": oldEtag } },
        mockEnv,
      );
      expect(res.status).toBe(200);
      const newEtag = res.headers.get("ETag");
      expect(newEtag).not.toBe(oldEtag);
    });

    it("RSS and Atom ETags for the same feed differ", async () => {
      const rssRes = await testApp.request(`/${FEED_ID}`, {}, mockEnv);
      const rssEtag = rssRes.headers.get("ETag")!;

      // Use a separate atom app to get the atom ETag
      const { handle: atomHandle } = await import("./atom");
      const atomApp = new Hono();
      atomApp.get("/:feedId", atomHandle);
      const atomRes = await atomApp.request(`/${FEED_ID}`, {}, mockEnv);
      const atomEtag = atomRes.headers.get("ETag")!;

      expect(rssEtag).not.toBe(atomEtag);
    });
  });
});
