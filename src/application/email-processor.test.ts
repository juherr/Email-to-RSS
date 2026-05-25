import { describe, it, expect, beforeEach } from "vitest";
import { http, HttpResponse } from "msw";
import { createMockEnv, MockR2, seedInboundIndex, server } from "../test/setup";
import {
  processEmail,
  ProcessEmailInput,
  RawAttachment,
} from "./email-processor";
import { getCounters } from "../application/stats";

const iconKey = (domain: string) => `icon:${domain}`;

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

  beforeEach(async () => {
    env = createMockEnv();
    // The inbound address resolves to a feed of the same id in these unit tests.
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("returns 400 when toAddress has no valid feedId", async () => {
    const res = await processEmail(
      makeInput({ toAddress: "invalid@domain.com" }),
      env as any,
    );
    expect(res).toMatchObject({ ok: false, reason: "invalid_address" });
  });

  it("returns mailbox_unknown when no feed claims the inbound address", async () => {
    // A well-formed mailbox (noun.noun.NN) that was never registered in the
    // inbound index — distinct from a dangling index pointing at a missing feed.
    const res = await processEmail(
      makeInput({ toAddress: "unknown.mailbox.99@test.getmynews.app" }),
      env as any,
    );
    expect(res).toMatchObject({ ok: false, reason: "mailbox_unknown" });
  });

  it("returns feed_not_found when the index resolves but the feed is gone", async () => {
    // The inbound index is seeded (beforeEach) but no config exists for it.
    const res = await processEmail(makeInput(), env as any);
    expect(res).toMatchObject({ ok: false, reason: "feed_not_found" });
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
    expect(res).toMatchObject({ ok: false, reason: "sender_blocked" });
  });

  it("returns 200 and stores email when sender is allowed by exact match", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: ["sender@example.com"] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.ok).toBe(true);
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
    expect(res.ok).toBe(true);
  });

  it("returns 200 when no allowlist is set", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ allowed_senders: [] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.ok).toBe(true);
  });

  it("returns 403 when sender is in blocklist by exact address", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ blocked_senders: ["sender@example.com"] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res).toMatchObject({ ok: false, reason: "sender_blocked" });
  });

  it("returns 403 when sender is in blocklist by domain", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ blocked_senders: ["example.com"] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res).toMatchObject({ ok: false, reason: "sender_blocked" });
  });

  it("returns 200 when sender is not in blocklist", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({ blocked_senders: ["other@example.com"] }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.ok).toBe(true);
  });

  it("exact block takes precedence over domain allow", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({
        allowed_senders: ["example.com"],
        blocked_senders: ["sender@example.com"],
      }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res).toMatchObject({ ok: false, reason: "sender_blocked" });
  });

  it("exact allow overrides domain block (exception use case)", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({
        allowed_senders: ["sender@example.com"],
        blocked_senders: ["example.com"],
      }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res.ok).toBe(true);
  });

  it("exact block takes precedence over exact allow", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({
        allowed_senders: ["sender@example.com"],
        blocked_senders: ["sender@example.com"],
      }),
    );
    const res = await processEmail(makeInput(), env as any);
    expect(res).toMatchObject({ ok: false, reason: "sender_blocked" });
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
    const email1 = JSON.stringify({
      subject: "Old1",
      from: "a@b.com",
      content: bigContent,
      receivedAt: 111,
      headers: {},
    });
    const email2 = JSON.stringify({
      subject: "Old2",
      from: "a@b.com",
      content: bigContent,
      receivedAt: 222,
      headers: {},
    });
    await env.EMAIL_STORAGE.put(oldKey1, email1);
    await env.EMAIL_STORAGE.put(oldKey2, email2);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [
          {
            key: oldKey2,
            subject: "Old2",
            receivedAt: 222,
            size: email2.length,
          },
          {
            key: oldKey1,
            subject: "Old1",
            receivedAt: 111,
            size: email1.length,
          },
        ],
      }),
    );

    const tinyEnv = { ...env, FEED_MAX_SIZE_BYTES: "50" };
    const res = await processEmail(
      makeInput({ subject: "New" }),
      tinyEnv as any,
    );
    expect(res.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
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
    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(2);
  });

  it("calls ctx.waitUntil with notifySubscribers when ctx is provided", async () => {
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({
        title: "Test",
        language: "en",
        created_at: Date.now(),
      }),
    );
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({ emails: [] }),
    );

    let waitUntilCalled = false;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilCalled = true;
        void p; // don't actually await it
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    const res = await processEmail(makeInput(), env as any, ctx);

    expect(res.ok).toBe(true);
    expect(waitUntilCalled).toBe(true);
  });

  it("does not call ctx.waitUntil on error paths (feed not found)", async () => {
    let waitUntilCalled = false;
    const ctx = {
      waitUntil: (p: Promise<unknown>) => {
        waitUntilCalled = true;
        void p;
      },
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    // Well-formed mailbox but not registered → mailbox_unknown (an error path).
    const res = await processEmail(
      makeInput({ toAddress: `no.such.99@test.getmynews.app` }),
      env as any,
      ctx,
    );

    expect(res).toMatchObject({ ok: false, reason: "mailbox_unknown" });
    expect(waitUntilCalled).toBe(false);
  });
});

describe("processEmail — attachments", () => {
  const pdfContent = new TextEncoder().encode("PDF bytes")
    .buffer as ArrayBuffer;

  const pdfAttachment: RawAttachment = {
    filename: "report.pdf",
    contentType: "application/pdf",
    content: pdfContent,
  };

  it("skips R2 upload when ATTACHMENT_BUCKET is not configured", async () => {
    const env = createMockEnv();
    await seedInboundIndex(env, VALID_FEED_ID);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const res = await processEmail(
      makeInput({ attachments: [pdfAttachment] }),
      env as any,
    );
    expect(res.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    const emailData = await env.EMAIL_STORAGE.get(
      metadata.emails[0].key,
      "json",
    );
    expect(emailData.attachments).toBeUndefined();
  });

  it("skips R2 upload when ATTACHMENTS_ENABLED is 'false' even with R2 bound", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    (env as any).ATTACHMENTS_ENABLED = "false";
    const mockR2 = (env as any).ATTACHMENT_BUCKET as unknown as MockR2;
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const res = await processEmail(
      makeInput({ attachments: [pdfAttachment] }),
      env as any,
    );
    expect(res.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    const emailData = await env.EMAIL_STORAGE.get(
      metadata.emails[0].key,
      "json",
    );
    expect(emailData.attachments).toBeUndefined();
    expect((await mockR2.list()).objects).toHaveLength(0);
  });

  it("uploads attachments to R2 and stores AttachmentData in emailData", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    const mockR2 = (env as any).ATTACHMENT_BUCKET as unknown as MockR2;
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    const res = await processEmail(
      makeInput({ attachments: [pdfAttachment] }),
      env as any,
    );
    expect(res.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    const emailData = await env.EMAIL_STORAGE.get(
      metadata.emails[0].key,
      "json",
    );

    expect(emailData.attachments).toHaveLength(1);
    expect(emailData.attachments[0].filename).toBe("report.pdf");
    expect(emailData.attachments[0].contentType).toBe("application/pdf");
    expect(emailData.attachments[0].size).toBe(pdfContent.byteLength);

    const id = emailData.attachments[0].id;
    expect(mockR2._has(id)).toBe(true);
  });

  it("stores attachmentIds in EmailMetadata for trim-time cleanup", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await processEmail(makeInput({ attachments: [pdfAttachment] }), env as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails[0].attachmentIds).toHaveLength(1);
    expect(typeof metadata.emails[0].attachmentIds[0]).toBe("string");
  });

  it("classifies a cid-referenced image as inline, not a downloadable attachment", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    const inlineImage: RawAttachment = {
      filename: "logo.png",
      contentType: "image/png",
      content: new TextEncoder().encode("PNG").buffer as ArrayBuffer,
      contentId: "logo123",
    };

    await processEmail(
      makeInput({
        content: '<p>Hi</p><img src="cid:logo123"/>',
        attachments: [inlineImage, pdfAttachment],
      }),
      env as any,
    );

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    const emailData = await env.EMAIL_STORAGE.get(
      metadata.emails[0].key,
      "json",
    );

    const inline = emailData.attachments.find(
      (a: any) => a.filename === "logo.png",
    );
    const pdf = emailData.attachments.find(
      (a: any) => a.filename === "report.pdf",
    );
    expect(inline.inline).toBe(true);
    expect(pdf.inline).toBeUndefined();

    // Metadata splits ids: the pdf is downloadable, the logo is inline-only.
    expect(metadata.emails[0].attachmentIds).toEqual([pdf.id]);
    expect(metadata.emails[0].inlineAttachmentIds).toEqual([inline.id]);
  });

  it("deletes inline image R2 objects when a trimmed email had them", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    const mockR2 = (env as any).ATTACHMENT_BUCKET as unknown as MockR2;
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    const oldKey = `feed:${VALID_FEED_ID}:111`;
    const inlineId = "old-inline-uuid";
    const oldEmail = JSON.stringify({
      subject: "Old",
      from: "a@b.com",
      content: "x".repeat(200) + '<img src="cid:c"/>',
      receivedAt: 111,
      headers: {},
      attachments: [
        {
          id: inlineId,
          filename: "logo.png",
          contentType: "image/png",
          size: 100,
          contentId: "c",
          inline: true,
        },
      ],
    });
    await env.EMAIL_STORAGE.put(oldKey, oldEmail);
    await mockR2.put(inlineId, new ArrayBuffer(100));
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [
          {
            key: oldKey,
            subject: "Old",
            receivedAt: 111,
            size: oldEmail.length,
            inlineAttachmentIds: [inlineId],
          },
        ],
      }),
    );

    const tinyEnv = { ...env, FEED_MAX_SIZE_BYTES: "50" };
    const res = await processEmail(
      makeInput({ subject: "New" }),
      tinyEnv as any,
    );
    expect(res.ok).toBe(true);
    expect(mockR2._has(inlineId)).toBe(false);
  });

  it("deletes R2 objects when a trimmed email had attachments", async () => {
    const env = createMockEnv({ withR2: true });
    await seedInboundIndex(env, VALID_FEED_ID);
    const mockR2 = (env as any).ATTACHMENT_BUCKET as unknown as MockR2;
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    // Store an old email with attachment in KV and metadata
    const oldKey = `feed:${VALID_FEED_ID}:111`;
    const oldAttachmentId = "old-attachment-uuid";
    const bigContent = "x".repeat(200);
    const oldEmail = JSON.stringify({
      subject: "Old",
      from: "a@b.com",
      content: bigContent,
      receivedAt: 111,
      headers: {},
      attachments: [
        {
          id: oldAttachmentId,
          filename: "old.pdf",
          contentType: "application/pdf",
          size: 100,
        },
      ],
    });
    await env.EMAIL_STORAGE.put(oldKey, oldEmail);

    // Also put the attachment in mock R2
    await mockR2.put(oldAttachmentId, new ArrayBuffer(100));

    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [
          {
            key: oldKey,
            subject: "Old",
            receivedAt: 111,
            size: oldEmail.length,
            attachmentIds: [oldAttachmentId],
          },
        ],
      }),
    );

    // Process with tight size budget to force trimming
    const tinyEnv = { ...env, FEED_MAX_SIZE_BYTES: "50" };
    const res = await processEmail(
      makeInput({ subject: "New" }),
      tinyEnv as any,
    );
    expect(res.ok).toBe(true);

    // Old attachment should be deleted from R2
    expect(mockR2._has(oldAttachmentId)).toBe(false);
  });
});

describe("processEmail — deduplication", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("stores only one email when the same Message-ID is delivered twice", async () => {
    const headers = { "Message-ID": "<abc123@example.com>" };
    await processEmail(makeInput({ headers }), env as any);
    await processEmail(makeInput({ headers }), env as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);
  });

  it("increments emails_deduplicated counter on the second delivery", async () => {
    const headers = { "Message-ID": "<dup42@example.com>" };
    await processEmail(makeInput({ headers }), env as any);
    await processEmail(makeInput({ headers }), env as any);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_deduplicated).toBe(1);
  });

  it("deduplicates by hash when no Message-ID header is present", async () => {
    const input = makeInput({
      subject: "Weekly Digest",
      content: "<p>Same content</p>",
    });
    await processEmail(input, env as any);
    await processEmail(input, env as any);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(1);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_deduplicated).toBe(1);
  });

  it("does not deduplicate emails with different subjects (no Message-ID)", async () => {
    await processEmail(
      makeInput({ subject: "First", content: "<p>body</p>" }),
      env as any,
    );
    await processEmail(
      makeInput({ subject: "Second", content: "<p>body</p>" }),
      env as any,
    );

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(2);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_deduplicated).toBe(0);
  });

  it("does not false-positive against pre-feature entries lacking messageId/dedupHash", async () => {
    // Seed a legacy metadata entry with no messageId or dedupHash
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:metadata`,
      JSON.stringify({
        emails: [
          {
            key: `feed:${VALID_FEED_ID}:999`,
            subject: "Old Subject",
            receivedAt: 999,
            size: 50,
            // intentionally no messageId, no dedupHash
          },
        ],
      }),
    );

    // A new, distinct email should be stored without triggering false dedup
    const res = await processEmail(
      makeInput({ subject: "New Distinct Email", content: "<p>fresh</p>" }),
      env as any,
    );
    expect(res.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails).toHaveLength(2);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_deduplicated).toBe(0);
  });

  it("returns { ok: true } for a genuine duplicate (not a rejection)", async () => {
    const headers = { "Message-ID": "<nodrop@example.com>" };
    await processEmail(makeInput({ headers }), env as any);
    const res = await processEmail(makeInput({ headers }), env as any);
    expect(res).toMatchObject({ ok: true });
  });

  it("stores messageId and dedupHash in the email metadata entry", async () => {
    const headers = { "Message-ID": "<stored@example.com>" };
    await processEmail(
      makeInput({ subject: "Sub", content: "<p>c</p>", headers }),
      env as any,
    );

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.emails[0].messageId).toBe("<stored@example.com>");
    expect(typeof metadata.emails[0].dedupHash).toBe("string");
    expect(metadata.emails[0].dedupHash).toHaveLength(64); // SHA-256 hex
  });
});

describe("processEmail — monitoring counters", () => {
  it("increments emails_received and sets last_email_at on success", async () => {
    const env = createMockEnv();
    await seedInboundIndex(env, VALID_FEED_ID);
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );

    await processEmail(makeInput(), env as any);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_received).toBe(1);
    expect(counters.emails_rejected).toBe(0);
    expect(counters.last_email_at).toBeDefined();
  });

  it("increments emails_rejected when validation fails", async () => {
    const env = createMockEnv();

    // No feed config → 404 rejection
    await processEmail(makeInput(), env as any);

    const counters = await getCounters(env.EMAIL_STORAGE as any);
    expect(counters.emails_rejected).toBe(1);
    expect(counters.emails_received).toBe(0);
  });
});

describe("processEmail — feed icon", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("persists the latest sender domain on the feed metadata", async () => {
    await processEmail(
      makeInput({ from: "News <news@github.com>" }),
      env as any,
    );

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as { iconDomain?: string };
    expect(metadata.iconDomain).toBe("github.com");
  });

  it("triggers a background favicon fetch via ctx.waitUntil", async () => {
    let fetched = false;
    server.use(
      http.get("https://github.com/favicon.ico", () => {
        fetched = true;
        return new HttpResponse(new Uint8Array([1, 2, 3]), {
          headers: { "Content-Type": "image/png" },
        });
      }),
    );

    const pending: Promise<unknown>[] = [];
    const ctx = {
      waitUntil: (p: Promise<unknown>) => pending.push(p),
      passThroughOnException: () => {},
    } as unknown as ExecutionContext;

    await processEmail(makeInput({ from: "news@github.com" }), env as any, ctx);
    await Promise.all(pending);

    expect(fetched).toBe(true);
    expect(
      await env.EMAIL_STORAGE.get(iconKey("github.com"), "json"),
    ).toMatchObject({ contentType: "image/png" });
  });
});

describe("processEmail — confirmation detection", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("marks a confirmation email and raises pendingConfirmation", async () => {
    const result = await processEmail(
      makeInput({
        subject: "Please confirm your subscription",
        content:
          '<p>Click <a href="https://example.com/confirm?token=abc">Confirm</a></p>',
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.pendingConfirmation).toBe(true);
    expect(metadata.emails[0].confirmation?.links[0]).toBe(
      "https://example.com/confirm?token=abc",
    );
  });

  it("marks a plain-text confirmation email and raises pendingConfirmation", async () => {
    const result = await processEmail(
      makeInput({
        subject: "Confirm your subscription",
        content:
          "Please confirm your subscription. Click here: https://example.com/confirm?token=xyz to verify your email.",
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.pendingConfirmation).toBe(true);
    expect(metadata.emails[0].confirmation?.links[0]).toBe(
      "https://example.com/confirm?token=xyz",
    );
  });

  it("does not mark a regular newsletter as a confirmation", async () => {
    const result = await processEmail(
      makeInput({
        subject: "Weekly Newsletter",
        content: "<p>Here is your weekly digest of news.</p>",
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    );
    expect(metadata.pendingConfirmation).toBeFalsy();
    expect(metadata.emails[0].confirmation).toBeUndefined();
  });
});

describe("processEmail — unsubscribe capture", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("stores the one-click unsubscribe URL on the feed metadata, keyed by sender", async () => {
    await processEmail(
      makeInput({
        senders: ["news@example.com"],
        headers: {
          "list-unsubscribe": "<https://example.com/u?t=abc>",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
      }),
      env as any,
    );

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as { unsubscribe?: Record<string, string> };
    expect(metadata.unsubscribe).toEqual({
      "news@example.com": "https://example.com/u?t=abc",
    });
  });

  it("keeps one entry per sender and overwrites with the latest URL", async () => {
    await processEmail(
      makeInput({
        subject: "Issue 1 from A",
        senders: ["a@one.com"],
        headers: {
          "list-unsubscribe": "<https://one.com/u/1>",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
      }),
      env as any,
    );
    await processEmail(
      makeInput({
        subject: "Issue 1 from B",
        senders: ["b@two.com"],
        headers: {
          "list-unsubscribe": "<https://two.com/u/1>",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
      }),
      env as any,
    );
    await processEmail(
      makeInput({
        subject: "Issue 2 from A",
        senders: ["a@one.com"],
        headers: {
          "list-unsubscribe": "<https://one.com/u/2>",
          "list-unsubscribe-post": "List-Unsubscribe=One-Click",
        },
      }),
      env as any,
    );

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as { unsubscribe?: Record<string, string> };
    expect(metadata.unsubscribe).toEqual({
      "a@one.com": "https://one.com/u/2",
      "b@two.com": "https://two.com/u/1",
    });
  });

  it("does not store anything without the one-click Post header", async () => {
    await processEmail(
      makeInput({
        headers: { "list-unsubscribe": "<https://example.com/u/1>" },
      }),
      env as any,
    );

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as { unsubscribe?: Record<string, string> };
    expect(metadata.unsubscribe).toBeUndefined();
  });
});

describe("native feed detection on ingest", () => {
  let env: ReturnType<typeof createMockEnv>;

  beforeEach(async () => {
    env = createMockEnv();
    await env.EMAIL_STORAGE.put(
      `feed:${VALID_FEED_ID}:config`,
      JSON.stringify({}),
    );
    await seedInboundIndex(env, VALID_FEED_ID);
  });

  it("stores detected native feeds on the feed metadata (TEST A)", async () => {
    const result = await processEmail(
      makeInput({
        from: "news@blog.example.com",
        senders: ["news@blog.example.com"],
        content:
          '<html><head><link rel="alternate" type="application/rss+xml" href="https://blog.example.com/feed.xml"></head><body>hello</body></html>',
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as {
      nativeFeeds?: Record<string, Array<{ url: string; type: string }>>;
    };
    expect(Object.values(metadata.nativeFeeds!).flat()).toEqual([
      { url: "https://blog.example.com/feed.xml", type: "rss" },
    ]);
  });

  it("does not store nativeFeeds when no feed links are found (TEST B)", async () => {
    const result = await processEmail(
      makeInput({
        content: "<p>no feed here</p>",
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as { nativeFeeds?: Record<string, unknown> };
    expect(metadata.nativeFeeds).toBeUndefined();
  });

  it("absolutizes a relative feed href using the display-name sender's domain (TEST C)", async () => {
    const result = await processEmail(
      makeInput({
        from: "Blog Name <news@blog.example.com>",
        senders: ["news@blog.example.com"],
        content:
          '<html><head><link rel="alternate" type="application/atom+xml" href="/atom.xml"></head><body>hi</body></html>',
      }),
      env as any,
    );

    expect(result.ok).toBe(true);

    const metadata = (await env.EMAIL_STORAGE.get(
      `feed:${VALID_FEED_ID}:metadata`,
      "json",
    )) as {
      nativeFeeds?: Record<string, Array<{ url: string; type: string }>>;
    };
    expect(Object.values(metadata.nativeFeeds!).flat()).toEqual([
      { url: "https://blog.example.com/atom.xml", type: "atom" },
    ]);
  });
});
