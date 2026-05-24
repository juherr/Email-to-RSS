import { Env, FeedConfig, EmailData, WebSubSubscription } from "../types";
import { generateRssFeed, generateAtomFeed } from "./feed-generator";
import { baseUrl, feedRssUrl, feedAtomUrl, feedUrl } from "./urls";
import { FeedRepository } from "./feed-repository";
import { WebSubSubscriptionRepository } from "./websub-subscription-repository";
import { FeedId } from "../domain/value-objects/feed-id";

export async function getSubscriptions(
  feedId: FeedId,
  env: Env,
): Promise<WebSubSubscription[]> {
  return WebSubSubscriptionRepository.from(env).get(feedId);
}

export async function saveSubscriptions(
  feedId: FeedId,
  subscriptions: WebSubSubscription[],
  env: Env,
): Promise<void> {
  await WebSubSubscriptionRepository.from(env).save(feedId, subscriptions);
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

async function buildFeedXml(
  feedId: FeedId,
  env: Env,
  format: "rss" | "atom" = "rss",
): Promise<string | null> {
  const repo = FeedRepository.from(env);
  const [feedMetadata, rawConfig] = await Promise.all([
    repo.getMetadata(feedId),
    repo.getConfig(feedId),
  ]);

  if (!feedMetadata) return null;

  const base = baseUrl(env);
  const feedConfig: FeedConfig = rawConfig ?? {
    title: `Newsletter Feed ${feedId.value}`,
    description: "Converted email newsletter",
    language: "en",
    created_at: Date.now(),
  };

  const emails = feedMetadata.emails.slice(0, 20);
  const emailsData = (
    await Promise.all(emails.map((m) => repo.getEmail(m.key)))
  ).filter((d): d is EmailData => d !== null);

  if (format === "atom") {
    return generateAtomFeed(
      feedConfig,
      emailsData,
      base,
      feedId.value,
      feedAtomUrl(feedId.value, env),
    );
  }
  return generateRssFeed(feedConfig, emailsData, base, feedId.value);
}

export async function notifySubscribers(
  feedId: FeedId,
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

  const rssSubs = active.filter((s) => (s.format ?? "rss") === "rss");
  const atomSubs = active.filter((s) => s.format === "atom");

  const [rssFeed, atomFeed] = await Promise.all([
    rssSubs.length > 0 ? buildFeedXml(feedId, env, "rss") : null,
    atomSubs.length > 0 ? buildFeedXml(feedId, env, "atom") : null,
  ]);

  if (!rssFeed && !atomFeed) return;

  const base = baseUrl(env);

  const deliver = async (
    sub: WebSubSubscription,
    feedXml: string,
    contentType: string,
    selfPath: string,
  ) => {
    const linkHeader = `<${base}/hub>; rel="hub", <${base}${selfPath}>; rel="self"`;
    const headers: Record<string, string> = {
      "Content-Type": contentType,
      Link: linkHeader,
    };
    if (sub.secret) {
      headers["X-Hub-Signature-256"] = await buildHmacSignature(
        feedXml,
        sub.secret,
      );
    }
    const res = await fetch(sub.callbackUrl, {
      method: "POST",
      headers,
      body: feedXml,
    });
    if (!res.ok) {
      console.error(
        `WebSub: delivery failed ${sub.callbackUrl}: ${res.status}`,
      );
    }
  };

  await Promise.allSettled([
    ...(rssFeed
      ? rssSubs.map((sub) =>
          deliver(sub, rssFeed, "application/rss+xml", `/rss/${feedId.value}`),
        )
      : []),
    ...(atomFeed
      ? atomSubs.map((sub) =>
          deliver(
            sub,
            atomFeed,
            "application/atom+xml",
            `/atom/${feedId.value}`,
          ),
        )
      : []),
  ]);

  if (active.length < subs.length) {
    await saveSubscriptions(feedId, active, env);
  }
}

async function verifyCallback(
  callbackUrl: string,
  params: Record<string, string>,
): Promise<boolean> {
  const challenge = crypto.randomUUID().replace(/-/g, "");
  const url = new URL(callbackUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("hub.challenge", challenge);

  let res: Response;
  try {
    res = await fetch(url.toString());
  } catch {
    return false;
  }

  if (!res.ok) return false;
  return (await res.text()).trim() === challenge;
}

export async function verifyAndStoreSubscription(
  feedId: FeedId,
  callbackUrl: string,
  secret: string | undefined,
  leaseSeconds: number,
  format: "rss" | "atom",
  env: Env,
): Promise<boolean> {
  const verified = await verifyCallback(callbackUrl, {
    "hub.mode": "subscribe",
    "hub.topic": feedUrl(format, feedId.value, env),
    "hub.lease_seconds": String(leaseSeconds),
  });
  if (!verified) return false;

  const subs = await getSubscriptions(feedId, env);
  const idx = subs.findIndex((s) => s.callbackUrl === callbackUrl);
  const entry: WebSubSubscription = {
    callbackUrl,
    expiresAt: Date.now() + leaseSeconds * 1000,
    format,
    ...(secret ? { secret } : {}),
  };
  if (idx >= 0) {
    subs[idx] = entry;
  } else {
    subs.push(entry);
  }
  await saveSubscriptions(feedId, subs, env);
  return true;
}

export async function verifyAndDeleteSubscription(
  feedId: FeedId,
  callbackUrl: string,
  env: Env,
): Promise<boolean> {
  const verified = await verifyCallback(callbackUrl, {
    "hub.mode": "unsubscribe",
    "hub.topic": feedRssUrl(feedId.value, env),
  });
  if (!verified) return false;

  const subs = await getSubscriptions(feedId, env);
  await saveSubscriptions(
    feedId,
    subs.filter((s) => s.callbackUrl !== callbackUrl),
    env,
  );
  return true;
}
