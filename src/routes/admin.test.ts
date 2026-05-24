import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { Hono } from "hono";
import app from "./admin";
import { createMockEnv, server } from "../test/setup";
import { getCounters } from "../application/stats";
import { Env } from "../types";

describe("Admin Routes", () => {
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

  describe("Authentication", () => {
    it("should redirect to login page when not authenticated", async () => {
      const res = await request("/admin");
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/login");
    });

    it("should allow access to login page without authentication", async () => {
      const res = await request("/admin/login");
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    it("should set auth cookie and redirect on successful login", async () => {
      const formData = new FormData();
      formData.append("password", "test-password");

      const res = await request("/admin/login", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin");
      const cookie = res.headers.get("Set-Cookie");
      expect(cookie).toContain("admin_auth=");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Strict");
      expect(cookie).toContain("Secure");
      expect(cookie).toContain("Path=/");
    });

    it("should reject login with incorrect password", async () => {
      const formData = new FormData();
      formData.append("password", "wrong-password");

      const res = await request("/admin/login", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/login?error=invalid");
    });

    it("should reject login with missing password", async () => {
      const formData = new FormData();

      const res = await request("/admin/login", {
        method: "POST",
        body: formData,
      });

      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/login?error=invalid");
    });
  });

  describe("Protected Routes", () => {
    it("should allow access to dashboard with valid auth cookie", async () => {
      const authCookie = await loginAndGetCookie();
      const res = await request("/admin", {
        headers: {
          Cookie: authCookie,
          Origin: "https://test.getmynews.app",
        },
      });
      expect(res.status).toBe(200);
      expect(res.headers.get("Content-Type")).toContain("text/html");
    });

    it("should reject access with forged auth cookie", async () => {
      const res = await request("/admin", {
        headers: {
          Cookie: "admin_auth=true",
        },
      });
      expect(res.status).toBe(302);
      expect(res.headers.get("Location")).toBe("/admin/login");
    });

    describe("Feed Creation", () => {
      it("should prevent feed creation without authentication", async () => {
        const formData = new FormData();
        formData.append("title", "Test Feed");
        formData.append("description", "Test Description");

        const res = await request("/admin/feeds/create", {
          method: "POST",
          body: formData,
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/admin/login");

        // Verify no feed was created
        const feedList = await mockEnv.EMAIL_STORAGE.get("feeds:list", "json");
        expect(feedList).toBeNull();
      });

      it("should allow feed creation with valid authentication", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "Test Feed");
        formData.append("description", "Test Description");

        const res = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        expect(res.status).toBe(302); // Redirects back to dashboard
        expect(res.headers.get("Location")).toBe("/admin?view=list#your-feeds");

        // Verify feed was created in KV
        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        expect(feedList).toBeTruthy();
        expect(feedList?.feeds.length).toBe(1);
        expect(feedList?.feeds[0].title).toBe("Test Feed");

        // Verify feed config was created
        const feedId = feedList?.feeds[0].id as string;
        const feedConfig = await mockEnv.EMAIL_STORAGE.get(
          `feed:${feedId}:config`,
          "json",
        );
        expect(feedConfig).toBeTruthy();
        expect((feedConfig as any).title).toBe("Test Feed");
        expect((feedConfig as any).description).toBe("Test Description");

        // Two-id model: the feed id is an opaque read id; the inbound address is
        // a separate noun.noun.NN mailbox, mapped via the inbound: index.
        const mailboxId = (feedConfig as any).mailbox_id as string;
        expect(mailboxId).toMatch(/^[a-z]+\.[a-z]+\.\d{2}$/);
        expect(feedId).toMatch(/^[A-Za-z0-9_-]{22}$/);
        expect(feedId).not.toBe(mailboxId);
        expect((feedList?.feeds[0] as any).mailbox_id).toBe(mailboxId);
        expect(
          await mockEnv.EMAIL_STORAGE.get(`inbound:${mailboxId}`, "text"),
        ).toBe(feedId);

        // The dashboard shows the inbound address and the opaque feed URL,
        // distinctly — and never exposes the address as a readable feed URL.
        const dash = await request("/admin", {
          headers: { Cookie: authCookie },
        });
        const html = await dash.text();
        expect(html).toContain(`${mailboxId}@test.getmynews.app`);
        expect(html).toContain(`/rss/${feedId}`);
        expect(html).not.toContain(`/rss/${mailboxId}`);

        // The feed-formats block surfaces all three formats (incl. JSON Feed)
        // plus per-format validator links.
        expect(html).toContain(`/atom/${feedId}`);
        expect(html).toContain(`/json/${feedId}`);
        expect(html).toContain("validator.jsonfeed.org");
        expect(html).toContain("validator.w3.org/feed");
      });

      it("should reject feed creation with missing title", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("description", "Test Description");

        const res = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        expect(res.status).toBe(400);

        // Verify no feed was created
        const feedList = await mockEnv.EMAIL_STORAGE.get("feeds:list", "json");
        expect(feedList).toBeNull();
      });
    });

    describe("API Feed Update", () => {
      it("returns 400 with structured validation error for empty title", async () => {
        const authCookie = await loginAndGetCookie();
        const res = await request("/admin/api/feeds/test-feed/update", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            "Content-Type": "application/json",
            Origin: "https://test.getmynews.app",
          },
          body: JSON.stringify({ title: "", description: "desc" }),
        });
        expect(res.status).toBe(400);
        const body = await res.json<{ success: boolean }>();
        expect(body.success).toBe(false);
      });
    });

    describe("Feed Management", () => {
      it("should prevent feed deletion without authentication", async () => {
        const res = await request("/admin/feeds/test-feed/delete", {
          method: "POST",
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/admin/login");
      });

      it("should prevent API feed updates without authentication", async () => {
        const res = await request("/admin/api/feeds/test-feed/update", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            title: "Updated Title",
            description: "Updated Description",
          }),
        });

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/admin/login");
      });

      it("should allow feed deletion with valid authentication", async () => {
        const authCookie = await loginAndGetCookie();
        // First create a feed
        const formData = new FormData();
        formData.append("title", "Test Feed");
        formData.append("description", "Test Description");

        const createRes = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        expect(createRes.status).toBe(302);

        // Get the feed ID
        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        const feedId = feedList?.feeds[0].id as string;

        // Now delete it
        const deleteRes = await request(`/admin/feeds/${feedId}/delete`, {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
        });

        expect(deleteRes.status).toBe(302);
        expect(deleteRes.headers.get("Location")).toBe("/admin?view=list");

        // Verify feed was deleted
        const updatedFeedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        expect(updatedFeedList).toBeTruthy();
        expect(updatedFeedList?.feeds.length).toBe(0);

        // Verify feed config was deleted
        const feedConfig = await mockEnv.EMAIL_STORAGE.get(
          `feed:${feedId}:config`,
          "json",
        );
        expect(feedConfig).toBeNull();
      });

      it("should return JSON for feed deletion when requested", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "JSON Feed");
        formData.append("description", "Test Description");

        const createRes = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        expect(createRes.status).toBe(302);

        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        const feedId = feedList?.feeds[0].id as string;

        const deleteRes = await request(
          `/admin/feeds/${feedId}/delete?view=list`,
          {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Accept: "application/json",
              Origin: "https://test.getmynews.app",
            },
          },
        );

        expect(deleteRes.status).toBe(200);
        const payload = (await deleteRes.json()) as any;
        expect(payload.ok).toBe(true);
        expect(payload.feedId).toBe(feedId);
      });

      it("fires one-click unsubscribe requests on feed deletion and bumps the counter", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "Unsub Feed");

        await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as {
          feeds: Array<{ id: string }>;
        } | null;
        const feedId = feedList?.feeds[0].id as string;

        // Simulate an ingested email having captured an unsubscribe URL.
        await mockEnv.EMAIL_STORAGE.put(
          `feed:${feedId}:metadata`,
          JSON.stringify({
            emails: [],
            unsubscribe: { "news@example.com": "https://example.com/u/1" },
          }),
        );

        let unsubHit = false;
        server.use(
          http.post("https://example.com/u/1", () => {
            unsubHit = true;
            return HttpResponse.text("ok");
          }),
        );

        const pending: Promise<unknown>[] = [];
        const ctx = {
          waitUntil: (p: Promise<unknown>) => pending.push(p),
          passThroughOnException: () => {},
        } as unknown as ExecutionContext;

        const deleteRes = await testApp.request(
          `/admin/feeds/${feedId}/delete`,
          {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Origin: "https://test.getmynews.app",
            },
          },
          mockEnv,
          ctx,
        );
        expect(deleteRes.status).toBe(302);

        await Promise.all(pending);

        expect(unsubHit).toBe(true);
        const counters = await getCounters(mockEnv.EMAIL_STORAGE);
        expect(counters.unsubscribes_sent).toBe(1);
      });

      it("sends no unsubscribe requests when the feed has none", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "No Unsub Feed");

        await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as {
          feeds: Array<{ id: string }>;
        } | null;
        const feedId = feedList?.feeds[0].id as string;

        const pending: Promise<unknown>[] = [];
        const ctx = {
          waitUntil: (p: Promise<unknown>) => pending.push(p),
          passThroughOnException: () => {},
        } as unknown as ExecutionContext;

        await testApp.request(
          `/admin/feeds/${feedId}/delete`,
          {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Origin: "https://test.getmynews.app",
            },
          },
          mockEnv,
          ctx,
        );

        await Promise.all(pending);

        const counters = await getCounters(mockEnv.EMAIL_STORAGE);
        expect(counters.unsubscribes_sent).toBe(0);
      });

      it("should allow bulk feed deletion with valid authentication", async () => {
        const authCookie = await loginAndGetCookie();

        for (const title of ["Feed A", "Feed B"]) {
          const formData = new FormData();
          formData.append("title", title);
          formData.append("description", "Test");
          const createRes = await request("/admin/feeds/create", {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Origin: "https://test.getmynews.app",
            },
            body: formData,
          });
          expect(createRes.status).toBe(302);
        }

        const feedListBefore = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as {
          feeds: Array<{ id: string; title: string }>;
        } | null;
        expect(feedListBefore?.feeds.length).toBe(2);

        const bulkForm = new FormData();
        for (const feed of feedListBefore?.feeds || []) {
          bulkForm.append("feedIds", feed.id);
        }

        const bulkDeleteRes = await request("/admin/feeds/bulk-delete", {
          method: "POST",
          headers: { Cookie: authCookie, Origin: "https://test.getmynews.app" },
          body: bulkForm,
        });

        expect(bulkDeleteRes.status).toBe(302);
        expect(bulkDeleteRes.headers.get("Location")).toContain(
          "/admin?view=list",
        );
        expect(bulkDeleteRes.headers.get("Location")).toContain(
          "message=bulkDeleted",
        );

        const feedListAfter = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as {
          feeds: Array<{ id: string; title: string }>;
        } | null;
        expect(feedListAfter?.feeds.length).toBe(0);
      });
    });

    describe("Proxy authentication", () => {
      const TRUSTED_IP = "10.0.0.1";
      const PROXY_SECRET = "my-proxy-secret";

      function proxyEnv() {
        return {
          ...createMockEnv(),
          PROXY_TRUSTED_IPS: TRUSTED_IP,
          PROXY_AUTH_SECRET: PROXY_SECRET,
        } as unknown as Env;
      }

      function makeProxyRequest(
        path: string,
        headers: Record<string, string> = {},
      ) {
        const proxyApp = new Hono();
        proxyApp.route("/admin", app);
        return proxyApp.request(path, { headers }, proxyEnv());
      }

      it("grants access when IP, secret and Remote-User are all valid", async () => {
        const res = await makeProxyRequest("/admin", {
          "CF-Connecting-IP": TRUSTED_IP,
          "X-Auth-Proxy-Secret": PROXY_SECRET,
          "Remote-User": "alice",
        });
        expect(res.status).toBe(200);
      });

      it("grants access using X-Forwarded-User instead of Remote-User", async () => {
        const res = await makeProxyRequest("/admin", {
          "CF-Connecting-IP": TRUSTED_IP,
          "X-Auth-Proxy-Secret": PROXY_SECRET,
          "X-Forwarded-User": "bob",
        });
        expect(res.status).toBe(200);
      });

      it("rejects when IP is not in trusted list", async () => {
        const res = await makeProxyRequest("/admin", {
          "CF-Connecting-IP": "1.2.3.4",
          "X-Auth-Proxy-Secret": PROXY_SECRET,
          "Remote-User": "alice",
        });
        expect(res.status).toBe(302);
      });

      it("rejects when secret is wrong", async () => {
        const res = await makeProxyRequest("/admin", {
          "CF-Connecting-IP": TRUSTED_IP,
          "X-Auth-Proxy-Secret": "wrong-secret",
          "Remote-User": "alice",
        });
        expect(res.status).toBe(302);
      });

      it("rejects when Remote-User is missing", async () => {
        const res = await makeProxyRequest("/admin", {
          "CF-Connecting-IP": TRUSTED_IP,
          "X-Auth-Proxy-Secret": PROXY_SECRET,
        });
        expect(res.status).toBe(302);
      });

      it("falls back to cookie auth when proxy env vars are not configured", async () => {
        const res = await request("/admin");
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/admin/login");
      });

      it("falls back to cookie auth when only one proxy env var is configured", async () => {
        const partialProxyApp = new Hono();
        partialProxyApp.route("/admin", app);
        const partialEnv = {
          ...createMockEnv(),
          PROXY_TRUSTED_IPS: "10.0.0.1",
          // PROXY_AUTH_SECRET intentionally absent
        } as unknown as Env;

        const res = await partialProxyApp.request(
          "/admin",
          {
            headers: {
              "CF-Connecting-IP": "10.0.0.1",
              "Remote-User": "alice",
              // No X-Auth-Proxy-Secret — proxy auth should NOT activate
            },
          },
          partialEnv,
        );
        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toBe("/admin/login");
      });
    });

    describe("Email Management", () => {
      it("should return JSON for email deletion when requested", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "Email Feed");
        formData.append("description", "Test Description");

        const createRes = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });

        expect(createRes.status).toBe(302);

        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        const feedId = feedList?.feeds[0].id as string;
        const emailKey = `feed:${feedId}:emails:123456`;

        await mockEnv.EMAIL_STORAGE.put(
          emailKey,
          JSON.stringify({
            subject: "Hello",
            from: "sender@example.com",
            content: "<p>Hi</p>",
            receivedAt: 123456,
            headers: {},
          }),
        );

        const feedMetadataKey = `feed:${feedId}:metadata`;
        const feedMetadata = (await mockEnv.EMAIL_STORAGE.get(
          feedMetadataKey,
          "json",
        )) as {
          emails: Array<{ key: string; subject: string; receivedAt: number }>;
        } | null;
        const updatedMetadata = {
          emails: [
            ...(feedMetadata?.emails || []),
            { key: emailKey, subject: "Hello", receivedAt: 123456 },
          ],
        };
        await mockEnv.EMAIL_STORAGE.put(
          feedMetadataKey,
          JSON.stringify(updatedMetadata),
        );

        const deleteRes = await request(
          `/admin/emails/${emailKey}/delete?feedId=${feedId}`,
          {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Accept: "application/json",
              Origin: "https://test.getmynews.app",
            },
          },
        );

        expect(deleteRes.status).toBe(200);
        const payload = (await deleteRes.json()) as any;
        expect(payload.ok).toBe(true);
        expect(payload.emailKey).toBe(emailKey);

        const deletedEmail = await mockEnv.EMAIL_STORAGE.get(emailKey, "json");
        expect(deletedEmail).toBeNull();

        const metadataAfter = (await mockEnv.EMAIL_STORAGE.get(
          feedMetadataKey,
          "json",
        )) as {
          emails: Array<{ key: string; subject: string; receivedAt: number }>;
        } | null;
        expect(metadataAfter?.emails.length).toBe(0);
      });

      it("should show a paperclip indicator only for emails with attachments", async () => {
        const authCookie = await loginAndGetCookie();
        const formData = new FormData();
        formData.append("title", "Email Feed");

        const createRes = await request("/admin/feeds/create", {
          method: "POST",
          headers: {
            Cookie: authCookie,
            Origin: "https://test.getmynews.app",
          },
          body: formData,
        });
        expect(createRes.status).toBe(302);

        const feedList = (await mockEnv.EMAIL_STORAGE.get(
          "feeds:list",
          "json",
        )) as { feeds: Array<{ id: string; title: string }> } | null;
        const feedId = feedList?.feeds[0].id as string;

        await mockEnv.EMAIL_STORAGE.put(
          `feed:${feedId}:metadata`,
          JSON.stringify({
            emails: [
              {
                key: `feed:${feedId}:1`,
                subject: "With attachments",
                receivedAt: 2,
                attachmentIds: ["att-1", "att-2"],
              },
              {
                key: `feed:${feedId}:2`,
                subject: "No attachments",
                receivedAt: 1,
              },
            ],
          }),
        );

        const res = await request(`/admin/feeds/${feedId}/emails`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const body = await res.text();

        expect(body).toContain("2 attachments");
        const indicatorCount = (body.match(/attachment-indicator/g) || [])
          .length;
        expect(indicatorCount).toBe(1);
      });

      it("lists attachments with download links on the email detail page", async () => {
        const authCookie = await loginAndGetCookie();
        const feedId = "detail-feed";
        await mockEnv.EMAIL_STORAGE.put(
          `feed:${feedId}:config`,
          JSON.stringify({
            title: "Detail Feed",
            mailbox_id: "detail.feed.10",
            language: "en",
            created_at: 1,
          }),
        );
        const emailKey = `feed:${feedId}:1`;
        await mockEnv.EMAIL_STORAGE.put(
          emailKey,
          JSON.stringify({
            subject: "With attachments",
            from: "sender@example.com",
            content: "<p>hello</p>",
            receivedAt: 1,
            headers: {},
            attachments: [
              {
                id: "att-123",
                filename: "report final.pdf",
                contentType: "application/pdf",
                size: 2048,
              },
            ],
          }),
        );

        const res = await request(`/admin/emails/${emailKey}`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const body = await res.text();

        expect(body).toContain("Attachments");
        expect(body).toContain(
          `/files/att-123/${encodeURIComponent("report final.pdf")}`,
        );
        expect(body).toContain("report final.pdf");
        expect(body).toContain("2.0 KB");
      });

      it("renders inline cid images in place and hides them from the attachments list", async () => {
        const authCookie = await loginAndGetCookie();
        const feedId = "detail-feed";
        await mockEnv.EMAIL_STORAGE.put(
          `feed:${feedId}:config`,
          JSON.stringify({
            title: "Detail Feed",
            mailbox_id: "detail.feed.10",
            language: "en",
            created_at: 1,
          }),
        );
        const emailKey = `feed:${feedId}:3`;
        await mockEnv.EMAIL_STORAGE.put(
          emailKey,
          JSON.stringify({
            subject: "With inline image",
            from: "sender@example.com",
            content: '<p>hello</p><img src="cid:logo123"/>',
            receivedAt: 3,
            headers: {},
            attachments: [
              {
                id: "img-1",
                filename: "logo.png",
                contentType: "image/png",
                size: 512,
                contentId: "logo123",
                inline: true,
              },
            ],
          }),
        );

        const res = await request(`/admin/emails/${emailKey}`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const body = await res.text();

        // The rendered preview is a base64 data: iframe; decode and inspect it.
        const match = body.match(/data:text\/html;base64,([A-Za-z0-9+/=]+)/);
        expect(match).not.toBeNull();
        const decoded = Buffer.from(match![1], "base64").toString("utf-8");
        // cid: is rewritten to an absolute /files URL so it resolves in the iframe.
        expect(decoded).toContain(
          "https://test.getmynews.app/files/img-1/logo.png",
        );
        expect(decoded).not.toContain("cid:logo123");

        // Inline image is not surfaced as a downloadable attachment.
        expect(body).not.toContain("Attachments");
      });

      it("does not render an attachments section when the email has none", async () => {
        const authCookie = await loginAndGetCookie();
        const feedId = "detail-feed";
        await mockEnv.EMAIL_STORAGE.put(
          `feed:${feedId}:config`,
          JSON.stringify({
            title: "Detail Feed",
            mailbox_id: "detail.feed.10",
            language: "en",
            created_at: 1,
          }),
        );
        const emailKey = `feed:${feedId}:2`;
        await mockEnv.EMAIL_STORAGE.put(
          emailKey,
          JSON.stringify({
            subject: "No attachments",
            from: "sender@example.com",
            content: "<p>hello</p>",
            receivedAt: 2,
            headers: {},
          }),
        );

        const res = await request(`/admin/emails/${emailKey}`, {
          headers: { Cookie: authCookie },
        });
        expect(res.status).toBe(200);
        const body = await res.text();

        expect(body).not.toContain("Attachments");
      });

      it("form-based bulk-delete also removes R2 attachments", async () => {
        const r2Env = createMockEnv({ withR2: true }) as unknown as Env;
        const bucket = r2Env.ATTACHMENT_BUCKET as unknown as {
          put: (k: string, v: string) => Promise<void>;
          _has: (k: string) => boolean;
        };
        await bucket.put("att-1", "data1");
        await bucket.put("att-2", "data2");

        const loginForm = new FormData();
        loginForm.append("password", "test-password");
        const loginRes = await testApp.request(
          "/admin/login",
          { method: "POST", body: loginForm },
          r2Env,
        );
        const authCookie = (loginRes.headers.get("Set-Cookie") as string).split(
          ";",
        )[0];

        const feedId = "bulk-r2-feed";
        await r2Env.EMAIL_STORAGE.put(
          "feeds:list",
          JSON.stringify({ feeds: [{ id: feedId, title: "F" }] }),
        );
        await r2Env.EMAIL_STORAGE.put(
          `feed:${feedId}:config`,
          JSON.stringify({ title: "F", language: "en", created_at: 1 }),
        );
        const emailKey = `feed:${feedId}:1`;
        await r2Env.EMAIL_STORAGE.put(
          emailKey,
          JSON.stringify({
            subject: "x",
            from: "a@b.c",
            content: "<p>x</p>",
            receivedAt: 1,
            headers: {},
            attachments: [{ id: "att-1" }, { id: "att-2" }],
          }),
        );
        await r2Env.EMAIL_STORAGE.put(
          `feed:${feedId}:metadata`,
          JSON.stringify({
            emails: [
              {
                key: emailKey,
                subject: "x",
                receivedAt: 1,
                attachmentIds: ["att-1", "att-2"],
              },
            ],
          }),
        );

        const form = new FormData();
        form.append("emailKeys", emailKey);
        const res = await testApp.request(
          `/admin/feeds/${feedId}/emails/bulk-delete`,
          {
            method: "POST",
            headers: {
              Cookie: authCookie,
              Origin: "https://test.getmynews.app",
            },
            body: form,
          },
          r2Env,
        );

        expect(res.status).toBe(302);
        expect(res.headers.get("Location")).toContain("bulkDeleted");
        expect(await r2Env.EMAIL_STORAGE.get(emailKey, "json")).toBeNull();
        expect(bucket._has("att-1")).toBe(false);
        expect(bucket._has("att-2")).toBe(false);
      });
    });
  });

  describe("Sender filter", () => {
    let authCookie: string;
    let feedId: string;

    beforeEach(async () => {
      authCookie = await loginAndGetCookie();
      const createRes = await request("/admin/feeds/create", {
        method: "POST",
        headers: {
          Cookie: authCookie,
          "Content-Type": "application/json",
          Origin: "https://test.getmynews.app",
        },
        body: JSON.stringify({ title: "Filter Test Feed" }),
      });
      const payload = (await createRes.json()) as { feedId: string };
      feedId = payload.feedId;
    });

    const post = (body: object, cookie = authCookie) =>
      request(`/admin/feeds/${feedId}/sender-filter`, {
        method: "POST",
        headers: {
          Cookie: cookie,
          "Content-Type": "application/json",
          Origin: "https://test.getmynews.app",
        },
        body: JSON.stringify(body),
      });

    it("adds exact email to allowlist", async () => {
      const res = await post({
        action: "allow_sender",
        value: "alice@example.com",
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as any).ok).toBe(true);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(cfg.allowed_senders).toContain("alice@example.com");
    });

    it("adds domain to allowlist", async () => {
      const res = await post({ action: "allow_domain", value: "example.com" });
      expect(res.status).toBe(200);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(cfg.allowed_senders).toContain("example.com");
    });

    it("adds exact email to blocklist", async () => {
      const res = await post({ action: "block_sender", value: "spam@bad.com" });
      expect(res.status).toBe(200);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(cfg.blocked_senders).toContain("spam@bad.com");
    });

    it("adds domain to blocklist", async () => {
      const res = await post({ action: "block_domain", value: "bad.com" });
      expect(res.status).toBe(200);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(cfg.blocked_senders).toContain("bad.com");
    });

    it("returns 409 when value already exists in the opposite list", async () => {
      await post({ action: "block_sender", value: "alice@example.com" });
      const res = await post({
        action: "allow_sender",
        value: "alice@example.com",
      });
      expect(res.status).toBe(409);
      const data = (await res.json()) as any;
      expect(data.ok).toBe(false);
      expect(data.error).toMatch(/blocklist/);
    });

    it("is idempotent when value already in target list", async () => {
      await post({ action: "allow_sender", value: "alice@example.com" });
      const res = await post({
        action: "allow_sender",
        value: "alice@example.com",
      });
      expect(res.status).toBe(200);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(
        cfg.allowed_senders.filter((s: string) => s === "alice@example.com")
          .length,
      ).toBe(1);
    });

    it("returns 400 for invalid action", async () => {
      const res = await post({
        action: "invalid_action",
        value: "alice@example.com",
      });
      expect(res.status).toBe(400);
    });

    it("normalizes value to lowercase", async () => {
      const res = await post({
        action: "allow_sender",
        value: "Alice@Example.COM",
      });
      expect(res.status).toBe(200);
      const cfg = (await mockEnv.EMAIL_STORAGE.get(
        `feed:${feedId}:config`,
        "json",
      )) as any;
      expect(cfg.allowed_senders).toContain("alice@example.com");
    });
  });
});
