import { Env, FeedConfig, FeedMetadata, EmailData } from "../types";

const MAX_FEED_ITEMS = 20;

export interface FeedData {
  feedConfig: FeedConfig;
  emails: EmailData[];
}

export async function fetchFeedData(
  feedId: string,
  env: Env,
  feedPath: "rss" | "atom",
): Promise<FeedData | null> {
  const storage = env.EMAIL_STORAGE;

  const feedMetadata = (await storage.get(
    `feed:${feedId}:metadata`,
    "json",
  )) as FeedMetadata | null;

  if (!feedMetadata) return null;

  const feedConfig = ((await storage.get(
    `feed:${feedId}:config`,
    "json",
  )) as FeedConfig | null) ?? {
    title: `Newsletter Feed ${feedId}`,
    description: "Converted email newsletter",
    site_url: `https://${env.DOMAIN}/${feedPath}/${feedId}`,
    feed_url: `https://${env.DOMAIN}/${feedPath}/${feedId}`,
    language: "en",
    created_at: Date.now(),
  };

  const emailRefs = feedMetadata.emails.slice(0, MAX_FEED_ITEMS);
  const emails: EmailData[] = [];
  for (const ref of emailRefs) {
    const data = (await storage.get(ref.key, "json")) as EmailData | null;
    if (data) emails.push(data);
  }

  return { feedConfig, emails };
}
