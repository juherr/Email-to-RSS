import {
  Env,
  FeedConfig,
  FeedMetadata,
  EmailData,
  WebSubSubscription,
} from "../types";
import { generateRssFeed } from "./feed-generator";

const KV_PREFIX = "websub:subs:";
const _DEFAULT_LEASE_SECONDS = 86400; // 24 h

export function subscriptionKey(feedId: string): string {
  return `${KV_PREFIX}${feedId}`;
}

export async function getSubscriptions(
  feedId: string,
  env: Env,
): Promise<WebSubSubscription[]> {
  const raw = await env.EMAIL_STORAGE.get(subscriptionKey(feedId), "json");
  return (raw as WebSubSubscription[] | null) ?? [];
}

export async function saveSubscriptions(
  feedId: string,
  subscriptions: WebSubSubscription[],
  env: Env,
): Promise<void> {
  await env.EMAIL_STORAGE.put(
    subscriptionKey(feedId),
    JSON.stringify(subscriptions),
  );
}

export async function buildHmacSignature(
  body: string,
  secret: string,
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(body),
  );
  const hex = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `sha256=${hex}`;
}

async function buildFeedXml(feedId: string, env: Env): Promise<string | null> {
  const [rawMetadata, rawConfig] = await Promise.all([
    env.EMAIL_STORAGE.get(`feed:${feedId}:metadata`, "json"),
    env.EMAIL_STORAGE.get(`feed:${feedId}:config`, "json"),
  ]);

  const feedMetadata = rawMetadata as FeedMetadata | null;
  if (!feedMetadata) return null;

  const feedConfig = (rawConfig as FeedConfig | null) ?? {
    title: `Newsletter Feed ${feedId}`,
    description: "Converted email newsletter",
    site_url: `https://${env.DOMAIN}/rss/${feedId}`,
    feed_url: `https://${env.DOMAIN}/rss/${feedId}`,
    language: "en",
    created_at: Date.now(),
  };

  const emails = feedMetadata.emails.slice(0, 20);
  const emailsData: EmailData[] = [];
  for (const meta of emails) {
    const data = (await env.EMAIL_STORAGE.get(
      meta.key,
      "json",
    )) as EmailData | null;
    if (data) emailsData.push(data);
  }

  return generateRssFeed(
    feedConfig,
    emailsData,
    `https://${env.DOMAIN}`,
    feedId,
  );
}

export async function notifySubscribers(
  feedId: string,
  env: Env,
): Promise<void> {
  const subs = await getSubscriptions(feedId, env);
  const now = Date.now();
  const active = subs.filter((s) => s.expiresAt > now);

  if (active.length === 0) {
    if (active.length < subs.length) {
      await saveSubscriptions(feedId, active, env);
    }
    return;
  }

  const feedXml = await buildFeedXml(feedId, env);
  if (!feedXml) return;

  const baseUrl = `https://${env.DOMAIN}`;
  const linkHeader = `<${baseUrl}/hub>; rel="hub", <${baseUrl}/rss/${feedId}>; rel="self"`;

  await Promise.allSettled(
    active.map(async (sub) => {
      const headers: Record<string, string> = {
        "Content-Type": "application/rss+xml",
        Link: linkHeader,
      };
      if (sub.secret) {
        headers["X-Hub-Signature"] = await buildHmacSignature(
          feedXml,
          sub.secret,
        );
        headers["X-Hub-Signature-256"] = headers["X-Hub-Signature"];
      }
      await fetch(sub.callbackUrl, { method: "POST", headers, body: feedXml });
    }),
  );

  if (active.length < subs.length) {
    await saveSubscriptions(feedId, active, env);
  }
}

export async function verifyAndStoreSubscription(
  feedId: string,
  callbackUrl: string,
  secret: string | undefined,
  leaseSeconds: number,
  env: Env,
): Promise<void> {
  const challenge = crypto.randomUUID().replace(/-/g, "");
  const topicUrl = `https://${env.DOMAIN}/rss/${feedId}`;
  const verifyUrl = new URL(callbackUrl);
  verifyUrl.searchParams.set("hub.mode", "subscribe");
  verifyUrl.searchParams.set("hub.topic", topicUrl);
  verifyUrl.searchParams.set("hub.challenge", challenge);
  verifyUrl.searchParams.set("hub.lease_seconds", String(leaseSeconds));

  let res: Response;
  try {
    res = await fetch(verifyUrl.toString());
  } catch {
    return;
  }

  if (!res.ok) return;
  const body = await res.text();
  if (body.trim() !== challenge) return;

  const subs = await getSubscriptions(feedId, env);
  const idx = subs.findIndex((s) => s.callbackUrl === callbackUrl);
  const entry: WebSubSubscription = {
    callbackUrl,
    expiresAt: Date.now() + leaseSeconds * 1000,
    ...(secret ? { secret } : {}),
  };
  if (idx >= 0) {
    subs[idx] = entry;
  } else {
    subs.push(entry);
  }
  await saveSubscriptions(feedId, subs, env);
}

export async function verifyAndDeleteSubscription(
  feedId: string,
  callbackUrl: string,
  env: Env,
): Promise<void> {
  const challenge = crypto.randomUUID().replace(/-/g, "");
  const topicUrl = `https://${env.DOMAIN}/rss/${feedId}`;
  const verifyUrl = new URL(callbackUrl);
  verifyUrl.searchParams.set("hub.mode", "unsubscribe");
  verifyUrl.searchParams.set("hub.topic", topicUrl);
  verifyUrl.searchParams.set("hub.challenge", challenge);

  let res: Response;
  try {
    res = await fetch(verifyUrl.toString());
  } catch {
    return;
  }

  if (!res.ok) return;
  const body = await res.text();
  if (body.trim() !== challenge) return;

  const subs = await getSubscriptions(feedId, env);
  await saveSubscriptions(
    feedId,
    subs.filter((s) => s.callbackUrl !== callbackUrl),
    env,
  );
}
