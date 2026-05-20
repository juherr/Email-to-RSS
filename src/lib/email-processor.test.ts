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
        emails: [{ key: "old-key", subject: "Old", receivedAt: 1 }],
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
});
