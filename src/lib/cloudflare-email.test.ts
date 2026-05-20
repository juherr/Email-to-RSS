import { describe, it, expect, beforeEach } from "vitest";
import "../test/setup";
import { createMockEnv } from "../test/setup";
import { handleCloudflareEmail } from "./cloudflare-email";

const VALID_FEED_ID = "apple.mountain.42";
const DOMAIN = "test.getmynews.app";

const RAW_EMAIL = [
  "From: Sender Name <sender@example.com>",
  `To: ${VALID_FEED_ID}@${DOMAIN}`,
  "Subject: Hello World",
  "Date: Thu, 01 Jan 2026 12:00:00 +0000",
  "MIME-Version: 1.0",
  "Content-Type: text/plain; charset=utf-8",
  "",
  "This is the email body.",
].join("\r\n");

function makeMessage(
  overrides: Partial<{ from: string; to: string; rawText: string }> = {},
): ForwardableEmailMessage {
  const rawText = overrides.rawText ?? RAW_EMAIL;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(rawText);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

  return {
    from: overrides.from ?? "sender@example.com",
    to: overrides.to ?? `${VALID_FEED_ID}@${DOMAIN}`,
    headers: new Headers(),
    raw: stream,
    rawSize: bytes.length,
    forward: async () => {},
    reply: async () => {},
    setReject: () => {},
  } as unknown as ForwardableEmailMessage;
}

describe("handleCloudflareEmail", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(() => {
    env = createMockEnv();
  });

  it("stores email in KV when feed exists", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    await handleCloudflareEmail(makeMessage(), env as any, {} as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);
    expect(metadata.emails[0].subject).toBe("Hello World");
  });

  it("does not throw when feed does not exist", async () => {
    await expect(
      handleCloudflareEmail(makeMessage(), env as any, {} as any),
    ).resolves.toBeUndefined();
  });

  it("does not throw when email is malformed", async () => {
    const msg = makeMessage({ rawText: "not a valid email" });
    await expect(
      handleCloudflareEmail(msg, env as any, {} as any),
    ).resolves.toBeUndefined();
  });

  it("uses sender from message.from for allowlist check", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );

    await handleCloudflareEmail(makeMessage(), env as any, {} as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);
  });

  it("rejects email when sender is not in allowlist (stored nothing)", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["other@example.com"] }),
    );

    await handleCloudflareEmail(makeMessage(), env as any, {} as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata).toBeNull();
  });
});
