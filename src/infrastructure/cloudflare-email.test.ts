import { describe, it, expect, beforeEach } from "vitest";
import "../test/setup";
import { createMockEnv } from "../test/setup";
import { handleCloudflareEmail } from "./cloudflare-email";
import { getCounters } from "../application/stats";

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
  overrides: Partial<{
    from: string;
    to: string;
    rawText: string;
    forward: (rcptTo: string, headers?: Headers) => Promise<void>;
  }> = {},
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
    forward: overrides.forward ?? (async () => {}),
    reply: async () => {},
    setReject: () => {},
  } as unknown as ForwardableEmailMessage;
}

/** Records every message.forward() call so tests can assert on routing. */
function spyForward() {
  const calls: string[] = [];
  const forward = async (rcptTo: string) => {
    calls.push(rcptTo);
  };
  return { calls, forward };
}

const FALLBACK = "fallback@personal.example";

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

    await handleCloudflareEmail(
      makeMessage(),
      env as any,
      { waitUntil: () => {} } as any,
    );

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);
    expect(metadata.emails[0].subject).toBe("Hello World");
  });

  it("does not throw when feed does not exist", async () => {
    await expect(
      handleCloudflareEmail(
        makeMessage(),
        env as any,
        { waitUntil: () => {} } as any,
      ),
    ).resolves.toBeUndefined();
  });

  it("does not throw when email is malformed", async () => {
    const msg = makeMessage({ rawText: "not a valid email" });
    await expect(
      handleCloudflareEmail(msg, env as any, { waitUntil: () => {} } as any),
    ).resolves.toBeUndefined();
  });

  it("uses sender from message.from for allowlist check", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );

    await handleCloudflareEmail(
      makeMessage(),
      env as any,
      { waitUntil: () => {} } as any,
    );

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

    await handleCloudflareEmail(
      makeMessage(),
      env as any,
      { waitUntil: () => {} } as any,
    );

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata).toBeNull();
  });

  describe("FALLBACK_FORWARD_ADDRESS catch-all fallback", () => {
    it("forwards to the fallback when the feed does not exist", async () => {
      const { calls, forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([FALLBACK]);
    });

    it("forwards to the fallback when the address is not a feed", async () => {
      const { calls, forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;

      await handleCloudflareEmail(
        makeMessage({ to: `not-a-feed@${DOMAIN}`, forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([FALLBACK]);
    });

    it("does NOT forward an expired feed's mail (no newsletter leak)", async () => {
      const { calls, forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      await env.EMAIL_STORAGE.put(
        `feed:${VALID_FEED_ID}:config`,
        JSON.stringify({ expires_at: Date.now() - 1000 }),
      );

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([]);
    });

    it("does NOT forward when the sender is blocked", async () => {
      const { calls, forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      await env.EMAIL_STORAGE.put(
        `feed:${VALID_FEED_ID}:config`,
        JSON.stringify({ allowed_senders: ["other@example.com"] }),
      );

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([]);
    });

    it("does NOT forward when the email was ingested", async () => {
      const { calls, forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      await env.EMAIL_STORAGE.put(
        `feed:${VALID_FEED_ID}:config`,
        JSON.stringify({}),
      );

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([]);
    });

    it("does NOT forward when the env var is unset (current drop behavior)", async () => {
      const { calls, forward } = spyForward();
      // env.FALLBACK_FORWARD_ADDRESS intentionally left unset.

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      expect(calls).toEqual([]);
    });

    it("does not throw when the fallback forward fails (unverified address)", async () => {
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      const forward = async () => {
        throw new Error("destination address not verified");
      };

      await expect(
        handleCloudflareEmail(
          makeMessage({ forward }),
          env as any,
          { waitUntil: () => {} } as any,
        ),
      ).resolves.toBeUndefined();
    });

    it("increments the emails_forwarded counter on a successful forward", async () => {
      const { forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      const counters = await getCounters(env.EMAIL_STORAGE as any);
      expect(counters.emails_forwarded).toBe(1);
    });

    it("does not increment emails_forwarded when the forward fails", async () => {
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      const forward = async () => {
        throw new Error("destination address not verified");
      };

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      const counters = await getCounters(env.EMAIL_STORAGE as any);
      expect(counters.emails_forwarded).toBe(0);
    });

    it("does not increment emails_forwarded for dropped reasons", async () => {
      const { forward } = spyForward();
      env.FALLBACK_FORWARD_ADDRESS = FALLBACK;
      await env.EMAIL_STORAGE.put(
        `feed:${VALID_FEED_ID}:config`,
        JSON.stringify({ expires_at: Date.now() - 1000 }),
      );

      await handleCloudflareEmail(
        makeMessage({ forward }),
        env as any,
        { waitUntil: () => {} } as any,
      );

      const counters = await getCounters(env.EMAIL_STORAGE as any);
      expect(counters.emails_forwarded).toBe(0);
    });
  });
});
