import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import app from "./admin";
import { createMockEnv } from "../test/setup";
import { Env } from "../types";

describe("OPML export — GET /admin/opml", () => {
  let testApp: Hono;
  let mockEnv: Env;
  let request: (path: string, init?: RequestInit) => Promise<Response>;
  let loginAndGetCookie: () => Promise<string>;

  beforeEach(() => {
    mockEnv = createMockEnv() as unknown as Env;
    testApp = new Hono();
    testApp.route("/admin", app);
    request = (path, init = {}) =>
      Promise.resolve(testApp.request(path, init, mockEnv));
    loginAndGetCookie = async () => {
      const formData = new FormData();
      formData.append("password", "test-password");
      const response = await request("/admin/login", {
        method: "POST",
        body: formData,
      });
      expect(response.status).toBe(302);
      const setCookie = response.headers.get("Set-Cookie");
      expect(setCookie).toBeTruthy();
      return (setCookie as string).split(";")[0];
    };
  });

  it("should return 302 redirect to login when not authenticated", async () => {
    const res = await request("/admin/opml");
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/admin/login");
  });

  it("should return 200 with OPML content when authenticated", async () => {
    // Seed two feeds in the registry
    await mockEnv.EMAIL_STORAGE.put(
      "feeds:list",
      JSON.stringify({
        feeds: [
          { id: "feed-abc", title: "My Newsletter", description: "Daily news" },
          { id: "feed-xyz", title: "Tech Digest" },
        ],
      }),
    );

    const authCookie = await loginAndGetCookie();
    const res = await request("/admin/opml", {
      headers: {
        Cookie: authCookie,
        Origin: "https://test.getmynews.app",
      },
    });

    expect(res.status).toBe(200);
    const contentType = res.headers.get("Content-Type") ?? "";
    expect(contentType).toContain("text/x-opml");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="feeds.opml"',
    );
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");

    const body = await res.text();

    // Valid OPML 2.0 structure
    expect(body).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(body).toContain('<opml version="2.0">');
    expect(body).toContain("<head>");
    expect(body).toContain("<title>kill-the-news feeds</title>");
    expect(body).toContain("<body>");

    // One outline per feed with correct xmlUrl
    expect(body).toContain('type="rss"');
    expect(body).toContain('text="My Newsletter"');
    expect(body).toContain('title="My Newsletter"');
    expect(body).toContain('xmlUrl="https://test.getmynews.app/rss/feed-abc"');
    expect(body).toContain('description="Daily news"');

    expect(body).toContain('text="Tech Digest"');
    expect(body).toContain('xmlUrl="https://test.getmynews.app/rss/feed-xyz"');

    // feed-xyz has no description — attribute must not appear
    const feedXyzLine =
      body.split("\n").find((l) => l.includes("feed-xyz")) ?? "";
    expect(feedXyzLine).not.toContain("description=");
  });

  it("should XML-escape special characters in title and description", async () => {
    await mockEnv.EMAIL_STORAGE.put(
      "feeds:list",
      JSON.stringify({
        feeds: [
          {
            id: "feed-special",
            title: "News & <Updates>",
            description: 'Say "hello" & goodbye',
          },
        ],
      }),
    );

    const authCookie = await loginAndGetCookie();
    const res = await request("/admin/opml", {
      headers: {
        Cookie: authCookie,
        Origin: "https://test.getmynews.app",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();

    // Raw special chars must not appear unescaped in attribute values
    const outlineLine =
      body.split("\n").find((l) => l.includes("feed-special")) ?? "";
    expect(outlineLine).toContain("News &amp; &lt;Updates&gt;");
    expect(outlineLine).toContain("Say &quot;hello&quot; &amp; goodbye");
    expect(outlineLine).not.toContain('title="News & <');
  });

  it("should return empty body element when there are no feeds", async () => {
    const authCookie = await loginAndGetCookie();
    const res = await request("/admin/opml", {
      headers: {
        Cookie: authCookie,
        Origin: "https://test.getmynews.app",
      },
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("<body>");
    expect(body).not.toContain("<outline");
  });
});
