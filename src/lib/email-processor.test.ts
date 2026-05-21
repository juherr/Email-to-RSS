import { describe, it, expect, beforeEach } from "vitest";
import "../test/setup";
import { createMockEnv } from "../test/setup";
import { processEmail, ProcessEmailInput } from "./email-processor";

const VALID_FEED_ID = "apple.mountain.42";
const VALID_TO = `${VALID_FEED_ID}@test.getmynews.app`;

function makeInput(
  overrides: Partial<ProcessEmailInput> = {},
): ProcessEmailInput {
  return {
    toAddress: VALID_TO,
    from: "Sender <sender@example.com>",
    senders: ["sender@example.com"],
    subject: "Test Subject",
    content: "<p>Hello</p>",
    receivedAt: 1700000000000,
    ...overrides,
  };
}

describe("processEmail", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("returns 400 when toAddress has no valid feedId", async () => {
    const res = await processEmail(
      makeInput({ toAddress: "invalid@domain.com" }),
      env as any,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when feed does not exist", async () => {
    const res = await processEmail(makeInput(), env as any);
    expect(res.status).toBe(404);
  });

  it("returns 403 when sender is not in allowlist", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["allowed@example.com"] }),
    );
    const res = await processEmail(
      makeInput({ senders: ["other@example.com"] }),
      env as any,
    );
    expect(res.status).toBe(403);
  });

  it("returns 200 and stores email when sender is allowed by exact match", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.status).toBe(200);
  });

  it("returns 200 and stores email when sender matches by domain", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["example.com"] }),
    );
    const res = await processEmail(
      makeInput({ senders: ["anyone@example.com"] }),
      env as any,
    );
    expect(res.status).toBe(200);
  });

  it("returns 200 when no allowlist is set", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: [] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.status).toBe(200);
  });

  it("stores email data and updates metadata in KV", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    const input = makeInput({ subject: "My Subject", content: "<b>body</b>" });
    await processEmail(input, env as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);
    expect(metadata.emails[0].subject).toBe("My Subject");

    const emailData = await env.EMAIL_STORAGE.get(
      metadata.emails[0].key,
      "json",
    );
    expect(emailData.subject).toBe("My Subject");
    expect(emailData.content).toBe("<b>body</b>");
    expect(emailData.from).toBe("Sender <sender@example.com>");
  });

  it("prepends to existing metadata", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [{ key: "old-key", subject: "Old", receivedAt: 1, size: 100 }],
      }),
    );

    await processEmail(makeInput({ subject: "New" }), env as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(2);
    expect(metadata.emails[0].subject).toBe("New");
    expect(metadata.emails[1].subject).toBe("Old");
  });

  it("trims oldest emails when total size exceeds FEED_MAX_SIZE_BYTES", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    const oldKey1 = `feed:${VALID_FEED_ID}:111`;
    const oldKey2 = `feed:${VALID_FEED_ID}:222`;
    const bigContent = "x".repeat(200);
    const email1 = JSON.stringify({ subject: "Old1", from: "a@b.com", content: bigContent, receivedAt: 111, headers: {} });
    const email2 = JSON.stringify({ subject: "Old2", from: "a@b.com", content: bigContent, receivedAt: 222, headers: {} });
    await env.EMAIL_STORAGE.put(oldKey1, email1);
    await env.EMAIL_STORAGE.put(oldKey2, email2);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [
          { key: oldKey2, subject: "Old2", receivedAt: 222, size: email2.length },
          { key: oldKey1, subject: "Old1", receivedAt: 111, size: email1.length },
        ],
      }),
    );

    const tinyEnv = { ...env, FEED_MAX_SIZE_BYTES: "50" };
    const res = await processEmail(makeInput({ subject: "New" }), tinyEnv as any);
    expect(res.status).toBe(200);

    const metadata = await env.EMAIL_STORAGE.get(`feed:${VALID_FEED_ID}:metadata`, "json");
    expect(metadata.emails).toHaveLength(1);
    expect(metadata.emails[0].subject).toBe("New");

    const deleted1 = await env.EMAIL_STORAGE.get(oldKey1, "json");
    const deleted2 = await env.EMAIL_STORAGE.get(oldKey2, "json");
    expect(deleted1).toBeNull();
    expect(deleted2).toBeNull();
  });

  it("keeps entries within size budget untouched", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const bigEnv = { ...env, FEED_MAX_SIZE_BYTES: String(10 * 1024 * 1024) };
    await processEmail(makeInput({ subject: "First" }), bigEnv as any);
    await processEmail(makeInput({ subject: "Second" }), bigEnv as any);
    const metadata = await env.EMAIL_STORAGE.get(`feed:${VALID_FEED_ID}:metadata`, "json");
    expect(metadata.emails).toHaveLength(2);
  });
});
