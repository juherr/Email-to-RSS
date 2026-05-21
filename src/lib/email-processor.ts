import { EmailParser } from "../utils/email-parser";
import { Env, FeedConfig, FeedMetadata } from "../types";

export interface ProcessEmailInput {
  toAddress: string;
  from: string;
  senders: string[];
  subject: string;
  content: string;
  receivedAt: number;
  headers?: Record<string, string>;
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

  const emailData = {
    subject: input.subject,
    from: input.from,
    content: input.content,
    receivedAt: input.receivedAt,
    headers: input.headers ?? {},
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
  feedMetadata.emails.unshift({
    key: emailKey,
    subject: emailData.subject,
    receivedAt: emailData.receivedAt,
    size: serialisedSize,
  });

  let totalSize = feedMetadata.emails.reduce((sum, e) => sum + (e.size ?? 0), 0);
  const toDelete: string[] = [];
  while (totalSize > maxBytes && feedMetadata.emails.length > 1) {
    const dropped = feedMetadata.emails.pop()!;
    totalSize -= dropped.size ?? 0;
    toDelete.push(dropped.key);
  }

  await Promise.all([
    env.EMAIL_STORAGE.put(feedMetadataKey, JSON.stringify(feedMetadata)),
    ...toDelete.map((k) => env.EMAIL_STORAGE.delete(k)),
  ]);

  console.log(`Successfully processed email for feed ${feedId}`);
  return new Response("Email processed successfully", { status: 200 });
}
