import { EmailParser } from "../utils/email-parser";
import { AttachmentData, EmailMetadata, Env, FeedConfig } from "../types";
import { notifySubscribers } from "../utils/websub";
import { bumpCounters } from "../utils/stats";
import {
  cacheFaviconForDomain,
  extractEmailDomain,
} from "../utils/favicon-fetcher";
import { parseOneClickUnsubscribe } from "../utils/unsubscribe";
import { getAttachmentBucket } from "../utils/attachments";
import { FeedRepository } from "../domain/feed-repository";
import { isExpired, applySenderPolicy, trimToByteBudget } from "../domain/feed";
import { logger } from "./logger";
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

type ValidationSuccess = { ok: true; feedId: string; feedConfig: FeedConfig };
type ValidationFailure = { ok: false; response: Response };
type ValidationResult = ValidationSuccess | ValidationFailure;

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

export async function validateEmail(
  input: ProcessEmailInput,
  env: Env,
): Promise<ValidationResult> {
  const feedId = EmailParser.extractFeedId(input.toAddress);
  if (!feedId) {
    logger.error("Invalid email address format", {
      toAddress: input.toAddress,
    });
    return {
      ok: false,
      response: new Response("Invalid email address format", { status: 400 }),
    };
  }

  const feedConfig = await FeedRepository.from(env).getConfig(feedId);
  if (!feedConfig) {
    logger.error("Feed not found", { feedId });
    return {
      ok: false,
      response: new Response("Feed does not exist", { status: 404 }),
    };
  }
  if (isExpired(feedConfig)) {
    logger.warn("Rejected email: feed expired", { feedId });
    return {
      ok: false,
      response: new Response("Feed has expired", { status: 410 }),
    };
  }

  if (applySenderPolicy(feedConfig, input.senders) === "blocked") {
    logger.warn("Rejected email: sender filter", {
      feedId,
      senders: input.senders,
      allowedSenders: feedConfig.allowed_senders,
      blockedSenders: feedConfig.blocked_senders,
    });
    return {
      ok: false,
      response: new Response("Sender not allowed for this feed", {
        status: 403,
      }),
    };
  }

  return { ok: true, feedId, feedConfig };
}

export async function storeEmail(
  feedId: string,
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
  const emailKey = repo.newEmailKey(feedId);

  const [, rawMetadata] = await Promise.all([
    repo.putEmail(emailKey, emailData),
    repo.getMetadata(feedId),
  ]);

  // Note: KV has no atomic compare-and-swap. Concurrent invocations for the
  // same feed can read stale metadata and produce orphaned KV entries or
  // duplicate trim deletions. This is an accepted limitation given Cloudflare
  // KV's eventual-consistency model.
  // TODO: Migrate feed metadata writes to Cloudflare Durable Objects to serialise
  // concurrent writes and eliminate this race condition.
  const feedMetadata = rawMetadata || { emails: [] };

  const maxBytes =
    parseInt(env.FEED_MAX_SIZE_BYTES ?? "", 10) || FEED_MAX_BYTES;

  const serialised = JSON.stringify(emailData);
  const serialisedSize = new TextEncoder().encode(serialised).byteLength;
  const newEntry: EmailMetadata = {
    key: emailKey,
    subject: emailData.subject,
    receivedAt: emailData.receivedAt,
    size: serialisedSize,
    ...(storedAttachments.length > 0
      ? { attachmentIds: storedAttachments.map((a) => a.id) }
      : {}),
  };
  feedMetadata.emails.unshift(newEntry);

  // Track the latest sender's domain so the feed icon follows the source.
  const iconDomain = extractEmailDomain(input.from);
  if (iconDomain) {
    feedMetadata.iconDomain = iconDomain;
  }

  // Capture the sender's RFC 8058 one-click unsubscribe link so we can stop the
  // newsletter when the feed is deleted. Keyed by sender: each newsletter on the
  // feed keeps its own entry, and a repeat send overwrites with the latest URL.
  const unsubUrl = parseOneClickUnsubscribe(input.headers ?? {});
  if (unsubUrl) {
    const senderKey =
      input.senders[0] || extractEmailDomain(input.from) || input.from;
    feedMetadata.unsubscribe = {
      ...(feedMetadata.unsubscribe ?? {}),
      [senderKey]: unsubUrl,
    };
  }

  const { dropped: toDelete } = trimToByteBudget(feedMetadata, maxBytes);

  const r2Deletions =
    attachmentBucket && toDelete.length > 0
      ? toDelete
          .flatMap((e) => e.attachmentIds ?? [])
          .map((id) => attachmentBucket.delete(id))
      : [];

  await Promise.all([
    repo.putMetadata(feedId, feedMetadata),
    ...toDelete.map((e) => repo.deleteEmail(e.key)),
    ...r2Deletions,
  ]);

  logger.info("Email processed", { feedId });
  if (ctx) {
    ctx.waitUntil(notifySubscribers(feedId, env));
    if (iconDomain) {
      ctx.waitUntil(cacheFaviconForDomain(iconDomain, env));
    }
  }
}

export async function processEmail(
  input: ProcessEmailInput,
  env: Env,
  ctx?: ExecutionContext,
): Promise<Response> {
  const validation = await validateEmail(input, env);
  if (!validation.ok) {
    await bumpCounters(env.EMAIL_STORAGE, { emails_rejected: 1 });
    return validation.response;
  }

  await storeEmail(validation.feedId, input, env, ctx);
  await bumpCounters(env.EMAIL_STORAGE, {
    emails_received: 1,
    last_email_at: new Date().toISOString(),
  });
  return new Response("Email processed successfully", { status: 200 });
}
