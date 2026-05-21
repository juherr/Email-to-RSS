import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server, createMockEnv } from "../test/setup";
import {
  buildHmacSignature,
  getSubscriptions,
  saveSubscriptions,
  notifySubscribers,
  verifyAndStoreSubscription,
  verifyAndDeleteSubscription,
  subscriptionKey,
} from "./websub";
import type { Env, WebSubSubscription } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;

describe("buildHmacSignature", () => {
  it("returns sha256= prefixed hex", async () => {
    const sig = await buildHmacSignature("hello", "secret");
    expect(sig).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it("produces different sigs for different secrets", async () => {
    const a = await buildHmacSignature("body", "secret1");
    const b = await buildHmacSignature("body", "secret2");
    expect(a).not.toBe(b);
  });

  it("produces the same sig for same inputs", async () => {
    const a = await buildHmacSignature("body", "secret");
    const b = await buildHmacSignature("body", "secret");
    expect(a).toBe(b);
  });
});

describe("getSubscriptions / saveSubscriptions", () => {
  it("returns empty array when no subs exist", async () => {
    const env = mockEnv();
    expect(await getSubscriptions("feed1", env)).toEqual([]);
  });

  it("round-trips stored subscriptions", async () => {
    const env = mockEnv();
    const subs: WebSubSubscription[] = [
      {
        callbackUrl: "https://reader.example/sub",
        expiresAt: Date.now() + 60000,
      },
    ];
    await saveSubscriptions("feed1", subs, env);
    expect(await getSubscriptions("feed1", env)).toEqual(subs);
  });

  it("uses the correct KV key", () => {
    expect(subscriptionKey("abc")).toBe("websub:subs:abc");
  });
});

describe("notifySubscribers", () => {
  it("does nothing when no subscriptions exist", async () => {
    const env = mockEnv();
    let called = false;
    server.use(
      http.post("https://reader.example/callback", () => {
        called = true;
        return HttpResponse.text("ok");
      }),
    );
    await notifySubscribers("feed1", env);
    expect(called).toBe(false);
  });

  it("does nothing when feed metadata missing", async () => {
    const env = mockEnv();
    const subs: WebSubSubscription[] = [
      {
        callbackUrl: "https://reader.example/callback",
        expiresAt: Date.now() + 60000,
      },
    ];
    await saveSubscriptions("feed1", subs, env);
    let called = false;
    server.use(
      http.post("https://reader.example/callback", () => {
        called = true;
        return HttpResponse.text("ok");
      }),
    );
    await notifySubscribers("feed1", env);
    expect(called).toBe(false);
  });

  it("POSTs feed XML to subscriber callback", async () => {
    const env = mockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:metadata",
      JSON.stringify({ emails: [] }),
    );
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({
        title: "Test Feed",
        language: "en",
        site_url: "https://example.com",
        feed_url: "https://example.com/rss/feed1",
        created_at: Date.now(),
      }),
    );
    const subs: WebSubSubscription[] = [
      {
        callbackUrl: "https://reader.example/callback",
        expiresAt: Date.now() + 60000,
      },
    ];
    await saveSubscriptions("feed1", subs, env);

    let receivedBody = "";
    let receivedContentType = "";
    server.use(
      http.post("https://reader.example/callback", async ({ request }) => {
        receivedBody = await request.text();
        receivedContentType = request.headers.get("Content-Type") ?? "";
        return HttpResponse.text("ok");
      }),
    );

    await notifySubscribers("feed1", env);

    expect(receivedBody).toContain("<?xml");
    expect(receivedContentType).toContain("application/rss+xml");
  });

  it("includes X-Hub-Signature-256 header when secret set (no X-Hub-Signature)", async () => {
    const env = mockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:metadata",
      JSON.stringify({ emails: [] }),
    );
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({
        title: "Test Feed",
        language: "en",
        site_url: "https://example.com",
        feed_url: "https://example.com/rss/feed1",
        created_at: Date.now(),
      }),
    );
    const subs: WebSubSubscription[] = [
      {
        callbackUrl: "https://reader.example/callback",
        expiresAt: Date.now() + 60000,
        secret: "mysecret",
      },
    ];
    await saveSubscriptions("feed1", subs, env);

    let receivedSig256 = "";
    let receivedSig = "";
    server.use(
      http.post("https://reader.example/callback", async ({ request }) => {
        receivedSig256 = request.headers.get("X-Hub-Signature-256") ?? "";
        receivedSig = request.headers.get("X-Hub-Signature") ?? "";
        return HttpResponse.text("ok");
      }),
    );

    await notifySubscribers("feed1", env);
    expect(receivedSig256).toMatch(/^sha256=[0-9a-f]{64}$/);
    expect(receivedSig).toBe(""); // legacy header should NOT be sent
  });

  it("prunes expired subscriptions and does not notify them", async () => {
    const env = mockEnv();
    await env.EMAIL_STORAGE.put(
      "feed:feed1:metadata",
      JSON.stringify({ emails: [] }),
    );
    await env.EMAIL_STORAGE.put(
      "feed:feed1:config",
      JSON.stringify({
        title: "Test Feed",
        language: "en",
        site_url: "https://example.com",
        feed_url: "https://example.com/rss/feed1",
        created_at: Date.now(),
      }),
    );
    const subs: WebSubSubscription[] = [
      {
        callbackUrl: "https://expired.example/callback",
        expiresAt: Date.now() - 1000,
      },
      {
        callbackUrl: "https://active.example/callback",
        expiresAt: Date.now() + 60000,
      },
    ];
    await saveSubscriptions("feed1", subs, env);

    const notified: string[] = [];
    server.use(
      http.post("https://expired.example/callback", () => {
        notified.push("expired");
        return HttpResponse.text("ok");
      }),
      http.post("https://active.example/callback", () => {
        notified.push("active");
        return HttpResponse.text("ok");
      }),
    );

    await notifySubscribers("feed1", env);
    expect(notified).toEqual(["active"]);

    const remaining = await getSubscriptions("feed1", env);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].callbackUrl).toBe("https://active.example/callback");
  });
});

describe("verifyAndStoreSubscription", () => {
  it("stores subscription and returns true when callback echoes challenge", async () => {
    const env = mockEnv();
    server.use(
      http.get("https://reader.example/callback", ({ request }) => {
        const url = new URL(request.url);
        const challenge = url.searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );

    const result = await verifyAndStoreSubscription(
      "feed1",
      "https://reader.example/callback",
      undefined,
      86400,
      env,
    );

    expect(result).toBe(true);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(1);
    expect(subs[0].callbackUrl).toBe("https://reader.example/callback");
    expect(subs[0].expiresAt).toBeGreaterThan(Date.now());
  });

  it("returns false and does not store when callback returns wrong challenge", async () => {
    const env = mockEnv();
    server.use(
      http.get("https://reader.example/callback", () =>
        HttpResponse.text("wrong"),
      ),
    );

    const result = await verifyAndStoreSubscription(
      "feed1",
      "https://reader.example/callback",
      undefined,
      86400,
      env,
    );

    expect(result).toBe(false);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(0);
  });

  it("updates existing subscription with same callback", async () => {
    const env = mockEnv();
    const existing: WebSubSubscription[] = [
      { callbackUrl: "https://reader.example/callback", expiresAt: 1000 },
    ];
    await saveSubscriptions("feed1", existing, env);

    server.use(
      http.get("https://reader.example/callback", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );

    const result = await verifyAndStoreSubscription(
      "feed1",
      "https://reader.example/callback",
      "newsecret",
      3600,
      env,
    );

    expect(result).toBe(true);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(1);
    expect(subs[0].secret).toBe("newsecret");
  });

  it("returns false when callback fetch fails", async () => {
    const env = mockEnv();
    server.use(
      http.get("https://reader.example/callback", () => HttpResponse.error()),
    );

    const result = await verifyAndStoreSubscription(
      "feed1",
      "https://reader.example/callback",
      undefined,
      86400,
      env,
    );

    expect(result).toBe(false);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(0);
  });

  it("returns false when callback returns non-ok HTTP status", async () => {
    const env = mockEnv();
    server.use(
      http.get("https://reader.example/callback", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge, { status: 500 });
      }),
    );

    const result = await verifyAndStoreSubscription(
      "feed1",
      "https://reader.example/callback",
      undefined,
      86400,
      env,
    );

    expect(result).toBe(false);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(0);
  });
});

describe("verifyAndDeleteSubscription", () => {
  it("removes subscription and returns true when callback echoes challenge", async () => {
    const env = mockEnv();
    await saveSubscriptions(
      "feed1",
      [
        {
          callbackUrl: "https://reader.example/callback",
          expiresAt: Date.now() + 60000,
        },
      ],
      env,
    );

    server.use(
      http.get("https://reader.example/callback", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );

    const result = await verifyAndDeleteSubscription(
      "feed1",
      "https://reader.example/callback",
      env,
    );
    expect(result).toBe(true);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(0);
  });

  it("returns false and leaves subscription intact when callback returns wrong challenge", async () => {
    const env = mockEnv();
    await saveSubscriptions(
      "feed1",
      [
        {
          callbackUrl: "https://reader.example/callback",
          expiresAt: Date.now() + 60000,
        },
      ],
      env,
    );

    server.use(
      http.get("https://reader.example/callback", () =>
        HttpResponse.text("nope"),
      ),
    );

    const result = await verifyAndDeleteSubscription(
      "feed1",
      "https://reader.example/callback",
      env,
    );
    expect(result).toBe(false);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(1);
  });

  it("returns false and leaves subscription intact when callback fetch fails", async () => {
    const env = mockEnv();
    await saveSubscriptions(
      "feed1",
      [
        {
          callbackUrl: "https://reader.example/callback",
          expiresAt: Date.now() + 60000,
        },
      ],
      env,
    );

    server.use(
      http.get("https://reader.example/callback", () => HttpResponse.error()),
    );

    const result = await verifyAndDeleteSubscription(
      "feed1",
      "https://reader.example/callback",
      env,
    );
    expect(result).toBe(false);
    const subs = await getSubscriptions("feed1", env);
    expect(subs).toHaveLength(1);
  });
});
