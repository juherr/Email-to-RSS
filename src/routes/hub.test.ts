import { describe, it, expect } from "vitest";
import { Hono } from "hono";
import { http, HttpResponse } from "msw";
import { server, createMockEnv } from "../test/setup";
import { hubRouter } from "./hub";

function makeApp() {
  const app = new Hono();
  app.route("/hub", hubRouter);
  return app;
}

function hubBody(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields).toString();
  return new Request("http://localhost/hub", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
}

describe("POST /hub — input validation", () => {
  it("returns 400 when hub.mode is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.topic is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.callback is missing", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 for unknown hub.mode", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "ping",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.callback is not HTTPS", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "http://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain("HTTPS");
  });

  it("returns 400 when hub.callback is not a valid URL", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "not-a-url",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.topic does not match this hub's domain", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": "https://other.example/rss/feed1",
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when hub.secret exceeds 200 bytes", async () => {
    const app = makeApp();
    const env = createMockEnv();
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
        "hub.secret": "x".repeat(201),
      }),
      env,
    );
    expect(res.status).toBe(400);
  });
});

describe("POST /hub — subscribe", () => {
  it("returns 202 for valid subscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });

  it("accepts hub.lease_seconds within range", async () => {
    const app = makeApp();
    const env = createMockEnv();
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "subscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
        "hub.lease_seconds": "3600",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });
});

describe("POST /hub — unsubscribe", () => {
  it("returns 202 for valid unsubscribe request", async () => {
    const app = makeApp();
    const env = createMockEnv();
    server.use(
      http.get("https://cb.example/sub", ({ request }) => {
        const challenge =
          new URL(request.url).searchParams.get("hub.challenge") ?? "";
        return HttpResponse.text(challenge);
      }),
    );
    const res = await app.request(
      "/hub",
      hubBody({
        "hub.mode": "unsubscribe",
        "hub.topic": `https://${env.DOMAIN}/rss/feed1`,
        "hub.callback": "https://cb.example/sub",
      }),
      env,
    );
    expect(res.status).toBe(202);
  });
});
