import { Env, FeedConfig, EmailData } from "../types";
import { MAX_FEED_ITEMS } from "../config/constants";
import { FeedRepository } from "../domain/feed-repository";
import { FeedId } from "../domain/value-objects/feed-id";

export interface FeedData {
  feedConfig: FeedConfig;
  emails: EmailData[];
}

export async function fetchFeedData(
  feedId: string,
  env: Env,
): Promise<FeedData | null> {
  const repo = FeedRepository.from(env);
  const id = FeedId.fromTrusted(feedId);

  const feedMetadata = await repo.getMetadata(id);
  if (!feedMetadata) return null;

  const feedConfig = (await repo.getConfig(id)) ?? {
    title: `Newsletter Feed ${feedId}`,
    description: "Converted email newsletter",
    language: "en",
    created_at: Date.now(),
  };

  const emailRefs = feedMetadata.emails.slice(0, MAX_FEED_ITEMS);
  const emails: EmailData[] = [];
  for (const ref of emailRefs) {
    const data = await repo.getEmail(ref.key);
    if (data) emails.push(data);
  }

  return { feedConfig, emails };
}
