import { EmailParser } from "../domain/email-parser";
import { AttachmentData, EmailMetadata, Env } from "../types";
import { bumpCounters } from "../application/stats";
import { dispatchFeedEvents } from "../application/feed-events";
import { extractEmailDomain } from "../infrastructure/favicon-fetcher";
import { parseOneClickUnsubscribe } from "../infrastructure/unsubscribe";
import { getAttachmentBucket } from "../infrastructure/attachments";
import { FeedRepository } from "../infrastructure/feed-repository";
import { BackgroundScheduler } from "../infrastructure/worker";
import { Feed } from "../domain/feed.aggregate";
import { logger } from "../infrastructure/logger";
import { FEED_MAX_BYTES } from "../config/constants";

export interface RawAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
  contentId?: string;
}

export interface ProcessEmailInput {
  toAddress: string;
  from: string;
  senders: string[];
  subject: string;
  content: string;
  receivedAt: number;
  headers?: Record<string, string>;
  attachments?: RawAttachment[];
}

export type IngestRejectionReason =
  | "invalid_address"
  | "feed_not_found"
  | "feed_expired"
  | "sender_blocked";

/**
 * Outcome of ingesting an email — a domain result, not an HTTP concern. The edge
 * (forwardemail.ts) maps this to a status code; the Cloudflare email handler
 * logs the reason. Keeping HTTP out of the core keeps ingestion transport-agnostic.
 */
export type IngestResult =
  | { ok: true; feedId: string }
  | { ok: false; reason: IngestRejectionReason };

async function uploadAttachments(
  attachments: RawAttachment[],
  bucket: R2Bucket,
): Promise<AttachmentData[]> {
  return Promise.all(
    attachments.map(async (att) => {
      const id = crypto.randomUUID();
      await bucket.put(id, att.content, {
        httpMetadata: {
          contentType: att.contentType,
          contentDisposition: `attachment; filename="${att.filename}"`,
        },
      });
      return {
        id,
        filename: att.filename,
        contentType: att.contentType,
        size: att.content.byteLength,
        ...(att.contentId ? { contentId: att.contentId } : {}),
      };
    }),
  );
}

async function loadAcceptingFeed(
  input: ProcessEmailInput,
  env: Env,
): Promise<
  { ok: true; feed: Feed } | { ok: false; reason: IngestRejectionReason }
> {
  const feedId = EmailParser.extractFeedId(input.toAddress);
  if (!feedId) {
    logger.error("Invalid email address format", {
      toAddress: input.toAddress,
    });
    return { ok: false, reason: "invalid_address" };
  }

  const feed = await FeedRepository.from(env).load(feedId);
  if (!feed) {
    logger.error("Feed not found", { feedId: feedId.value });
    return { ok: false, reason: "feed_not_found" };
  }
  if (feed.isExpired()) {
    logger.warn("Rejected email: feed expired", { feedId: feedId.value });
    return { ok: false, reason: "feed_expired" };
  }
  if (feed.accepts(input.senders) === "blocked") {
    logger.warn("Rejected email: sender filter", {
      feedId: feedId.value,
      senders: input.senders,
      allowedSenders: feed.allowedSenders(),
      blockedSenders: feed.blockedSenders(),
    });
    return { ok: false, reason: "sender_blocked" };
  }

  return { ok: true, feed };
}

async function storeEmail(
  feed: Feed,
  input: ProcessEmailInput,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const attachmentBucket = getAttachmentBucket(env);
  const storedAttachments: AttachmentData[] =
    attachmentBucket && input.attachments?.length
      ? await uploadAttachments(input.attachments, attachmentBucket)
      : [];

  const emailData = {
    subject: input.subject,
    from: input.from,
    content: input.content,
    receivedAt: input.receivedAt,
    headers: input.headers ?? {},
    ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
  };

  const repo = FeedRepository.from(env);
  const emailKey = repo.newEmailKey(feed.id);
  await repo.putEmail(emailKey, emailData);

  const serialisedSize = new TextEncoder().encode(
    JSON.stringify(emailData),
  ).byteLength;
  const newEntry: EmailMetadata = {
    key: emailKey,
    subject: emailData.subject,
    receivedAt: emailData.receivedAt,
    size: serialisedSize,
    ...(storedAttachments.length > 0
      ? { attachmentIds: storedAttachments.map((a) => a.id) }
      : {}),
  };

  // Track the latest sender's domain (feed icon) and capture the RFC 8058
  // one-click unsubscribe link, keyed by sender so each newsletter keeps its
  // own latest URL (fired when the feed is deleted).
  const iconDomain = extractEmailDomain(input.from);
  const unsubUrl = parseOneClickUnsubscribe(input.headers ?? {});
  const unsub = unsubUrl
    ? {
        senderKey: input.senders[0] || iconDomain || input.from,
        url: unsubUrl,
      }
    : undefined;

  const maxBytes =
    parseInt(env.FEED_MAX_SIZE_BYTES ?? "", 10) || FEED_MAX_BYTES;

  const { dropped } = feed.ingest(newEntry, {
    maxBytes,
    iconDomain: iconDomain ?? undefined,
    unsub,
  });

  const r2Deletions =
    attachmentBucket && dropped.length > 0
      ? dropped
          .flatMap((e) => e.attachmentIds ?? [])
          .map((id) => attachmentBucket.delete(id))
      : [];

  // KV has no compare-and-swap: the load (in loadAcceptingFeed) and this write
  // are not serialised, so concurrent ingests for one feed can lose updates.
  // Accepted under KV's eventual-consistency model; the Feed aggregate is the
  // seam a Durable Object would later wrap to serialise these writers.
  await Promise.all([
    repo.saveMetadata(feed),
    ...dropped.map((e) => repo.deleteEmail(e.key)),
    ...r2Deletions,
  ]);

  logger.info("Email processed", { feedId: feed.id.value });

  // The aggregate recorded an EmailIngested event; the dispatcher applies its
  // side effects (received counter, WebSub ping, favicon fetch). Background work
  // rides on ctx.waitUntil when present, and is skipped in its absence (tests).
  const schedule: BackgroundScheduler = ctx
    ? (p) => ctx.waitUntil(p)
    : () => {};
  await dispatchFeedEvents(feed, env, schedule);
}

export async function processEmail(
  input: ProcessEmailInput,
  env: Env,
  ctx?: ExecutionContext,
): Promise<IngestResult> {
  const validation = await loadAcceptingFeed(input, env);
  if (!validation.ok) {
    await bumpCounters(env.EMAIL_STORAGE, { emails_rejected: 1 });
    return validation;
  }

  await storeEmail(validation.feed, input, env, ctx);
  return { ok: true, feedId: validation.feed.id.value };
}
