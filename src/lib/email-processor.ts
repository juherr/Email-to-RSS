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

  const feedMetadata = ((rawMetadata as FeedMetadata | null) || {
    emails: [],
  }) as FeedMetadata;
  feedMetadata.emails.unshift({
    key: emailKey,
    subject: emailData.subject,
    receivedAt: emailData.receivedAt,
  });
  if (feedMetadata.emails.length > 50) {
    feedMetadata.emails = feedMetadata.emails.slice(0, 50);
  }
  await env.EMAIL_STORAGE.put(feedMetadataKey, JSON.stringify(feedMetadata));

  console.log(`Successfully processed email for feed ${feedId}`);
  return new Response("Email processed successfully", { status: 200 });
}
