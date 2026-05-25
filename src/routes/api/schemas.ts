import { z } from "@hono/zod-openapi";

// ── Shared ──────────────────────────────────────────────────────────────────

export const ErrorSchema = z
  .object({
    error: z.string().openapi({ example: "Feed not found" }),
  })
  .openapi("Error");

export const FeedIdParam = z.object({
  feedId: z
    .string()
    .min(1)
    .openapi({
      param: { name: "feedId", in: "path" },
      description:
        "The feed's opaque id (the read id in /rss/:feedId), not the inbound address.",
      example: "kZ8xQ2pLm4nR7vT1wB9yJc",
    }),
});

export const EntryIdParam = FeedIdParam.extend({
  entryId: z
    .string()
    .regex(/^\d+$/, "entryId must be the email's receivedAt timestamp")
    .openapi({
      param: { name: "entryId", in: "path" },
      example: "1737000000000",
    }),
});

// ── Feeds ───────────────────────────────────────────────────────────────────

export const FeedCreateSchema = z
  .object({
    title: z.string().min(1).openapi({ example: "Daily Tech Digest" }),
    description: z.string().optional(),
    language: z.string().optional().default("en"),
    allowedSenders: z.array(z.string()).optional().default([]),
    blockedSenders: z.array(z.string()).optional().default([]),
    senderInTitle: z.boolean().optional().openapi({
      description:
        "Render entry titles as `[Sender] Subject` in the feed output.",
    }),
    lifetimeHours: z.number().int().positive().optional().openapi({
      description:
        "Hours until the feed expires. Ignored when the server enforces a fixed FEED_TTL_HOURS.",
    }),
  })
  .openapi("FeedCreate");

export const FeedUpdateSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().optional(),
    language: z.string().optional(),
    allowedSenders: z.array(z.string()).optional(),
    blockedSenders: z.array(z.string()).optional(),
    senderInTitle: z.boolean().optional().openapi({
      description:
        "Render entry titles as `[Sender] Subject` in the feed output.",
    }),
    lifetimeHours: z.number().int().positive().optional().openapi({
      description: "Reset the feed's lifetime to this many hours from now.",
    }),
  })
  .openapi("FeedUpdate");

export const FeedSummarySchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    expiresAt: z.number().optional(),
    emailAddress: z.string(),
    rssUrl: z.string(),
    atomUrl: z.string(),
  })
  .openapi("FeedSummary");

export const FeedListSchema = z
  .object({ feeds: z.array(FeedSummarySchema) })
  .openapi("FeedList");

export const FeedSchema = z
  .object({
    id: z.string(),
    title: z.string(),
    description: z.string().optional(),
    language: z.string(),
    allowedSenders: z.array(z.string()),
    blockedSenders: z.array(z.string()),
    senderInTitle: z.boolean(),
    createdAt: z.number(),
    updatedAt: z.number().optional(),
    expiresAt: z.number().optional(),
    emailCount: z.number(),
    emailAddress: z.string(),
    rssUrl: z.string(),
    atomUrl: z.string(),
  })
  .openapi("Feed");

// ── Emails ──────────────────────────────────────────────────────────────────

export const EmailSummarySchema = z
  .object({
    entryId: z.number().openapi({
      description: "Email receivedAt timestamp; used as the path id.",
    }),
    subject: z.string(),
    receivedAt: z.number(),
    size: z.number().optional(),
    attachmentIds: z.array(z.string()).optional(),
  })
  .openapi("EmailSummary");

export const EmailListSchema = z
  .object({ emails: z.array(EmailSummarySchema) })
  .openapi("EmailList");

export const AttachmentSchema = z
  .object({
    id: z.string(),
    filename: z.string(),
    contentType: z.string(),
    size: z.number(),
    url: z.string(),
  })
  .openapi("Attachment");

export const EmailSchema = z
  .object({
    entryId: z.number(),
    subject: z.string(),
    from: z.string(),
    receivedAt: z.number(),
    content: z.string(),
    attachments: z.array(AttachmentSchema),
  })
  .openapi("Email");

// ── Stats ───────────────────────────────────────────────────────────────────

export const StatsSchema = z
  .object({
    feeds_created: z.number(),
    feeds_deleted: z.number(),
    emails_received: z.number(),
    emails_rejected: z.number(),
    emails_forwarded: z.number(),
    unsubscribes_sent: z.number(),
    active_feeds: z.number(),
    websub_subscriptions_active: z.number(),
    attachments_enabled: z.boolean(),
    version: z.string().openapi({
      description: "Running app version (package.json), inlined at build time.",
    }),
    last_email_at: z.string().optional(),
    last_feed_created_at: z.string().optional(),
    first_seen: z.string().optional(),
    attachments_bytes: z.number().optional(),
    attachments_count: z.number().optional(),
    kv_bytes_estimated: z.number().optional(),
    storage_scanned_at: z.string().optional(),
  })
  .openapi("Stats");
