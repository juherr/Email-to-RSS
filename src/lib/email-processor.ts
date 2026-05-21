import { EmailParser } from "../utils/email-parser";
import {
  AttachmentData,
  EmailMetadata,
  Env,
  FeedConfig,
  FeedMetadata,
} from "../types";

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

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function senderMatchesAllowlist(
  sender: string,
  allowedSender: string, // already normalized by caller
): boolean {
  if (!allowedSender) return false;

  const normalizedSender = normalizeEmail(sender);

  if (allowedSender.includes("@")) {
    return normalizedSender === allowedSender;
  }

  const senderDomain = normalizedSender.split("@")[1] || "";
  const normalizedDomain = allowedSender.startsWith("@")
    ? allowedSender.slice(1)
    : allowedSender;
  return senderDomain === normalizedDomain;
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

export async function processEmail(
  input: ProcessEmailInput,
  env: Env,
): Promise<Response> {
  const feedId = EmailParser.extractFeedId(input.toAddress);
  if (!feedId) {
    console.error(`Invalid email address format: ${input.toAddress}`);
    return new Response("Invalid email address format", { status: 400 });
  }

  const feedConfig = (await env.EMAIL_STORAGE.get(
    `feed:${feedId}:config`,
    "json",
  )) as FeedConfig | null;
  if (!feedConfig) {
    console.error(`Feed with ID ${feedId} does not exist or has been deleted`);
    return new Response("Feed does not exist", { status: 404 });
  }

  const allowedSenders = (feedConfig.allowed_senders || [])
    .map(normalizeEmail)
    .filter(Boolean);
  if (allowedSenders.length > 0) {
    const senderAllowed = input.senders.some((sender) =>
      allowedSenders.some((allowedSender) =>
        senderMatchesAllowlist(sender, allowedSender),
      ),
    );
    if (!senderAllowed) {
      console.warn(
        `Rejected email for feed ${feedId}; sender not in allowlist`,
        {
          senders: input.senders,
          allowedSenders,
        },
      );
      return new Response("Sender not allowed for this feed", { status: 403 });
    }
  }

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
  const feedMetadata = ((rawMetadata as FeedMetadata | null) || {
    emails: [],
  }) as FeedMetadata;

  const DEFAULT_MAX_BYTES = 524288; // 512 KB
  const maxBytes =
    parseInt(env.FEED_MAX_SIZE_BYTES ?? "", 10) || DEFAULT_MAX_BYTES;

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

  console.log(`Successfully processed email for feed ${feedId}`);
  return new Response("Email processed successfully", { status: 200 });
}
