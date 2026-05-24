import { describe, it, expect, beforeEach } from "vitest";
import { Hono } from "hono";
import { handle } from "./entries";
import { createMockEnv } from "../test/setup";

const FEED_ID = "test-feed";
const RECEIVED_AT = 1700000001000;
const EMAIL_KEY = `feed:${FEED_ID}:${RECEIVED_AT}`;

function makeApp() {
  const app = new Hono();
  app.get("/:feedId/:entryId", handle);
  return app;
}

async function seedFeed(
  env: ReturnType<typeof createMockEnv>,
  attachments?: {
    id: string;
    filename: string;
    contentType: string;
    size: number;
    contentId?: string;
    inline?: boolean;
  }[],
  content = "<p>Email body</p>",
) {
  await env.EMAIL_STORAGE.put(
    EMAIL_KEY,
    JSON.stringify({
      subject: "Test Subject",
      from: "sender@example.com",
      content,
      receivedAt: RECEIVED_AT,
      headers: {},
      ...(attachments ? { attachments } : {}),
    }),
  );
  await env.EMAIL_STORAGE.put(
    `feed:${FEED_ID}:metadata`,
    JSON.stringify({
      emails: [
        { key: EMAIL_KEY, subject: "Test Subject", receivedAt: RECEIVED_AT },
      ],
    }),
  );
}

describe("GET /entries/:feedId/:entryId", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("returns 404 when feed does not exist", async () => {
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/999`, {}, env as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Feed not found");
  });

  it("returns 404 when entry does not exist in metadata", async () => {
    const app = makeApp();
    await env.EMAIL_STORAGE.put(
      `feed:${FEED_ID}:metadata`,
      JSON.stringify({ emails: [] }),
    );
    const res = await app.request(`/${FEED_ID}/999`, {}, env as any);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("Entry not found");
  });

  it("returns 404 when entryId is not a number", async () => {
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/not-a-number`, {}, env as any);
    expect(res.status).toBe(404);
  });

  it("returns 200 with HTML for valid entry", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/html");
  });

  it("includes email subject in HTML title", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    expect(body).toContain("Test Subject");
  });

  it("includes email content in HTML body", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    expect(body).toContain("<p>Email body</p>");
  });

  it("includes sender in HTML", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    expect(body).toContain("sender@example.com");
  });

  it("lists attachments with download links when present", async () => {
    await seedFeed(env, [
      {
        id: "att-123",
        filename: "report final.pdf",
        contentType: "application/pdf",
        size: 2048,
      },
    ]);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    expect(body).toContain("Attachments");
    expect(body).toContain("report final.pdf");
    expect(body).toContain(
      `/files/att-123/${encodeURIComponent("report final.pdf")}`,
    );
    expect(body).toContain("2.0 KB");
  });

  it("renders inline images in place and omits them from the attachments list", async () => {
    await seedFeed(
      env,
      [
        {
          id: "img-1",
          filename: "logo.png",
          contentType: "image/png",
          size: 512,
          contentId: "logo123",
          inline: true,
        },
      ],
      '<p>Body</p><img src="cid:logo123"/>',
    );
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    // The cid: ref is rewritten to the stored file URL (rendered in place)…
    expect(body).toContain('src="/files/img-1/logo.png"');
    expect(body).not.toContain("cid:logo123");
    // …and the image is not listed as a downloadable attachment.
    expect(body).not.toContain("Attachments");
  });

  it("does not render an attachments section when there are none", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    const body = await res.text();
    expect(body).not.toContain("Attachments");
  });

  it("sets Content-Security-Policy header", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    expect(res.headers.get("Content-Security-Policy")).toContain(
      "default-src 'none'",
    );
  });

  it("sets X-Robots-Tag: noindex", async () => {
    await seedFeed(env);
    const app = makeApp();
    const res = await app.request(`/${FEED_ID}/${RECEIVED_AT}`, {}, env as any);
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });
});
