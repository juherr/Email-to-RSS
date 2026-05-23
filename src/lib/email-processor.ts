import { EmailParser } from "../utils/email-parser";
import {
  AttachmentData,
  EmailMetadata,
  Env,
  FeedConfig,
  FeedMetadata,
} from "../types";
import { notifySubscribers } from "../utils/websub";
import { bumpCounters } from "../utils/stats";
import {
  cacheFaviconForDomain,
  extractEmailDomain,
} from "../utils/favicon-fetcher";
import { parseOneClickUnsubscribe } from "../utils/unsubscribe";
import { logger } from "./logger";
import { FEED_MAX_BYTES } from "../config/constants";

export interface RawAttachment {
  filename: string;
  contentType: string;
  content: ArrayBuffer;
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

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

type SenderDecision = "blocked" | "allowed" | "neutral";

function evaluateSender(
  sender: string,
  allowedSenders: string[],
  blockedSenders: string[],
): SenderDecision {
  const normalized = normalizeEmail(sender);
  const domain = normalized.split("@")[1] || "";

  const normalizeDomain = (e: string) => (e.startsWith("@") ? e.slice(1) : e);

  const exactBlocked = blockedSenders.filter((e) => e.includes("@"));
  const exactAllowed = allowedSenders.filter((e) => e.includes("@"));
  const domainBlocked = blockedSenders
    .filter((e) => !e.includes("@"))
    .map(normalizeDomain);
  const domainAllowed = allowedSenders
    .filter((e) => !e.includes("@"))
    .map(normalizeDomain);

  if (exactBlocked.includes(normalized)) return "blocked";
  if (exactAllowed.includes(normalized)) return "allowed";
  if (domain && domainBlocked.includes(domain)) return "blocked";
  if (domain && domainAllowed.includes(domain)) return "allowed";
  return "neutral";
}

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

  const feedConfig = (await env.EMAIL_STORAGE.get(
    `feed:${feedId}:config`,
    "json",
  )) as FeedConfig | null;
  if (!feedConfig) {
    logger.error("Feed not found", { feedId });
    return {
      ok: false,
      response: new Response("Feed does not exist", { status: 404 }),
    };
  }
  if (
    feedConfig.expires_at !== undefined &&
    feedConfig.expires_at <= Date.now()
  ) {
    logger.warn("Rejected email: feed expired", { feedId });
    return {
      ok: false,
      response: new Response("Feed has expired", { status: 410 }),
    };
  }

  const allowedSenders = (feedConfig.allowed_senders || [])
    .map(normalizeEmail)
    .filter(Boolean);
  const blockedSenders = (feedConfig.blocked_senders || [])
    .map(normalizeEmail)
    .filter(Boolean);

  if (allowedSenders.length > 0 || blockedSenders.length > 0) {
    const hasAllowlist = allowedSenders.length > 0;
    const accepted = input.senders.some((sender) => {
      const decision = evaluateSender(sender, allowedSenders, blockedSenders);
      if (decision === "allowed") return true;
      if (decision === "blocked") return false;
      return !hasAllowlist;
    });

    if (!accepted) {
      logger.warn("Rejected email: sender filter", {
        feedId,
        senders: input.senders,
        allowedSenders,
        blockedSenders,
      });
      return {
        ok: false,
        response: new Response("Sender not allowed for this feed", {
          status: 403,
        }),
      };
    }
  }

  return { ok: true, feedId, feedConfig };
}

export async function storeEmail(
  feedId: string,
  input: ProcessEmailInput,
  env: Env,
  ctx?: ExecutionContext,
): Promise<void> {
  const storedAttachments: AttachmentData[] =
    env.ATTACHMENT_BUCKET && input.attachments?.length
      ? await uploadAttachments(input.attachments, env.ATTACHMENT_BUCKET)
      : [];

  const emailData = {
    subject: input.subject,
    from: input.from,
    content: input.content,
    receivedAt: input.receivedAt,
    headers: input.headers ?? {},
    ...(storedAttachments.length > 0 ? { attachments: storedAttachments } : {}),
  };

  const emailKey = `feed:${feedId}:${Date.now()}`;
  const feedMetadataKey = `feed:${feedId}:metadata`;

  const [, rawMetadata] = await Promise.all([
    env.EMAIL_STORAGE.put(emailKey, JSON.stringify(emailData)),
    env.EMAIL_STORAGE.get(feedMetadataKey, "json"),
  ]);

  // Note: KV has no atomic compare-and-swap. Concurrent invocations for the
  // same feed can read stale metadata and produce orphaned KV entries or
  // duplicate trim deletions. This is an accepted limitation given Cloudflare
  // KV's eventual-consistency model.
  // TODO: Migrate feed metadata writes to Cloudflare Durable Objects to serialise
  // concurrent writes and eliminate this race condition.
  const feedMetadata = ((rawMetadata as FeedMetadata | null) || {
    emails: [],
  }) as FeedMetadata;

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

  let totalSize = feedMetadata.emails.reduce(
    (sum, e) => sum + (e.size ?? 0),
    0,
  );
  const toDelete: EmailMetadata[] = [];
  while (totalSize > maxBytes && feedMetadata.emails.length > 1) {
    const dropped = feedMetadata.emails.pop()!;
    totalSize -= dropped.size ?? 0;
    toDelete.push(dropped);
  }

  const r2Deletions =
    env.ATTACHMENT_BUCKET && toDelete.length > 0
      ? toDelete
          .flatMap((e) => e.attachmentIds ?? [])
          .map((id) => env.ATTACHMENT_BUCKET!.delete(id))
      : [];

  await Promise.all([
    env.EMAIL_STORAGE.put(feedMetadataKey, JSON.stringify(feedMetadata)),
    ...toDelete.map((e) => env.EMAIL_STORAGE.delete(e.key)),
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
