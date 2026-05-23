import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import worker from "../index";
import { server, createMockEnv, MockR2 } from "../test/setup";
import type { Env } from "../types";
import type { ForwardEmailPayload } from "../lib/forwardemail";

const AUTHORIZED_IP = "138.197.213.185"; // first fallback IP
const DOMAIN = "test.getmynews.app";
const VALID_FEED_ID = "apple.mountain.42";
const VALID_TO = `${VALID_FEED_ID}@${DOMAIN}`;

function makeRequest(
  payload: Partial<ForwardEmailPayload> | null,
  ip = AUTHORIZED_IP,
): Request {
  return new Request(`https://${DOMAIN}/api/inbound`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": ip,
    },
    body: payload === null ? "not-json{{{" : JSON.stringify(payload),
  });
}

function makePayload(
  overrides: Partial<ForwardEmailPayload> = {},
): ForwardEmailPayload {
  return {
    recipients: [VALID_TO],
    from: {
      value: [{ address: "sender@example.com", name: "Sender" }],
      text: "Sender <sender@example.com>",
    },
    subject: "Test Subject",
    html: "<p>Hello</p>",
    ...overrides,
  };
}

// Stub the ForwardEmail IP lookup so tests work without network access.
// Returns a minimal list that includes AUTHORIZED_IP.
function stubForwardEmailIps() {
  server.use(
    http.get("https://forwardemail.net/ips/v4.json", () =>
      HttpResponse.json([
        {
          hostname: "mx1.forwardemail.net",
          ipv4: [AUTHORIZED_IP],
          updated: "",
        },
      ]),
    ),
  );
}

describe("POST /api/inbound — IP middleware", () => {
  let env: Env;

  beforeEach(async () => {
    env = createMockEnv() as unknown as Env;
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: [] }),
    );
  });

  it("returns 401 when IP is not in the ForwardEmail allowlist", async () => {
    stubForwardEmailIps();
    const res = await worker.fetch(makeRequest(makePayload(), "1.2.3.4"), env);
    expect(res.status).toBe(401);
  });

  it("passes through to the handler when IP is authorised", async () => {
    stubForwardEmailIps();
    const res = await worker.fetch(
      makeRequest(makePayload(), AUTHORIZED_IP),
      env,
    );
    expect(res.status).toBe(200);
  });

  it("falls back to hardcoded IPs and accepts request when ForwardEmail API is down", async () => {
    server.use(
      http.get("https://forwardemail.net/ips/v4.json", () =>
        HttpResponse.error(),
      ),
    );
    // AUTHORIZED_IP is in the hardcoded fallback list
    const res = await worker.fetch(
      makeRequest(makePayload(), AUTHORIZED_IP),
      env,
    );
    expect(res.status).toBe(200);
  });
});

describe("POST /api/inbound — handler logic", () => {
  let env: Env;

  beforeEach(() => {
    stubForwardEmailIps();
    env = createMockEnv() as unknown as Env;
  });

  it("returns 500 on malformed JSON body", async () => {
    const res = await worker.fetch(makeRequest(null), env);
    expect(res.status).toBe(500);
  });

  it("returns 400 when recipient address has no valid feed ID", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const res = await worker.fetch(
      makeRequest(makePayload({ recipients: ["notafeedid@example.com"] })),
      env,
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when feed does not exist in KV", async () => {
    const res = await worker.fetch(makeRequest(makePayload()), env);
    expect(res.status).toBe(404);
  });

  it("returns 403 when sender is not in the allowlist", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["allowed@example.com"] }),
    );
    const res = await worker.fetch(makeRequest(makePayload()), env);
    expect(res.status).toBe(403);
  });

  it("returns 200 when sender matches allowlist by exact address", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );
    const res = await worker.fetch(makeRequest(makePayload()), env);
    expect(res.status).toBe(200);
  });

  it("returns 200 when sender matches allowlist by domain", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["example.com"] }),
    );
    const res = await worker.fetch(makeRequest(makePayload()), env);
    expect(res.status).toBe(200);
  });

  it("returns 200 when allowlist is empty (open feed)", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: [] }),
    );
    const res = await worker.fetch(makeRequest(makePayload()), env);
    expect(res.status).toBe(200);
  });

  it("stores email data and metadata in KV on success", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const res = await worker.fetch(
      makeRequest(makePayload({ subject: "Hello KV" })),
      env,
    );
    expect(res.status).toBe(200);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      { type: "json" },
    )) as any;
    expect(metadata.emails).toHaveLength(1);
    expect(metadata.emails[0].subject).toBe("Hello KV");

    const emailData = (await env.EMAIL_STORAGE.get(metadata.emails[0].key, {
      type: "json",
    })) as any;
    expect(emailData.subject).toBe("Hello KV");
    expect(emailData.from).toContain("sender@example.com");
  });

  it("extracts sender from from.text when from.value is absent", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );
    const payload = makePayload({
      from: { text: "sender@example.com" },
    });
    const res = await worker.fetch(makeRequest(payload), env);
    expect(res.status).toBe(200);
  });

  it("uses HTML body when available, falls back to text", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const htmlRes = await worker.fetch(
      makeRequest(makePayload({ html: "<b>rich</b>", text: "plain" })),
      env,
    );
    expect(htmlRes.status).toBe(200);
    const htmlMeta = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      { type: "json" },
    )) as any;
    const htmlEmail = (await env.EMAIL_STORAGE.get(htmlMeta.emails[0].key, {
      type: "json",
    })) as any;
    expect(htmlEmail.content).toBe("<b>rich</b>");
  });
});

describe("POST /api/inbound — attachment upload", () => {
  let env: Env;

  beforeEach(() => {
    stubForwardEmailIps();
    env = createMockEnv({ withR2: true }) as unknown as Env;
  });

  it("uploads attachments to R2 and records ids in metadata", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const payload = makePayload({
      attachments: [
        {
          filename: "doc.pdf",
          contentType: "application/pdf",
          content: { type: "Buffer", data: [80, 68, 70] },
        },
      ],
    });
    const res = await worker.fetch(makeRequest(payload), env);
    expect(res.status).toBe(200);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      { type: "json" },
    )) as any;
    expect(metadata.emails[0].attachmentIds).toHaveLength(1);

    const mockR2 = (env as any).ATTACHMENT_BUCKET as unknown as MockR2;
    const attachmentId = metadata.emails[0].attachmentIds[0];
    expect(mockR2._has(attachmentId)).toBe(true);
  });

  it("persists the attachment Content-ID and rewrites inline cid: images on the entry page", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const payload = makePayload({
      html: '<p>hi</p><img src="cid:ii_mpi85rqy0" alt="pic"/>',
      attachments: [
        {
          filename: "pic.png",
          contentType: "image/png",
          cid: "ii_mpi85rqy0",
          content: { type: "Buffer", data: [137, 80, 78] },
        },
      ],
    });
    const res = await worker.fetch(makeRequest(payload), env);
    expect(res.status).toBe(200);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      { type: "json" },
    )) as any;
    const emailData = (await env.EMAIL_STORAGE.get(metadata.emails[0].key, {
      type: "json",
    })) as any;
    const attachmentId = emailData.attachments[0].id;
    expect(emailData.attachments[0].contentId).toBe("ii_mpi85rqy0");

    const entryRes = await worker.fetch(
      new Request(
        `https://${DOMAIN}/entries/${VALID_FEED_ID}/${metadata.emails[0].receivedAt}`,
      ),
      env,
    );
    expect(entryRes.status).toBe(200);
    const html = await entryRes.text();
    expect(html).toContain(`/files/${attachmentId}/pic.png`);
    expect(html).not.toContain("cid:ii_mpi85rqy0");
  });

  it("skips R2 when attachment content is null", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const payload = makePayload({
      attachments: [
        {
          filename: "empty.txt",
          contentType: "text/plain",
          content: undefined,
        },
      ],
    });
    const res = await worker.fetch(makeRequest(payload), env);
    expect(res.status).toBe(200);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      { type: "json" },
    )) as any;
    expect(metadata.emails[0].attachmentIds).toBeUndefined();
  });
});
