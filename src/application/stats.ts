import { Counters, Env, StatsResponse } from "../types";
import { logger } from "../infrastructure/logger";
import { FeedRepository } from "../infrastructure/feed-repository";
import { CountersRepository } from "../infrastructure/counters-repository";
import { WebSubSubscriptionRepository } from "../infrastructure/websub-subscription-repository";
import { FeedId } from "../domain/value-objects/feed-id";
import { getAttachmentBucket } from "../infrastructure/attachments";

const EMPTY_COUNTERS: Counters = {
  feeds_created: 0,
  feeds_deleted: 0,
  emails_received: 0,
  emails_rejected: 0,
  unsubscribes_sent: 0,
};

export async function getCounters(kv: KVNamespace): Promise<Counters> {
  try {
    const stored = await new CountersRepository(kv).getRaw();
    return { ...EMPTY_COUNTERS, ...(stored || {}) };
  } catch (error) {
    logger.error("Error reading counters", { error: String(error) });
    return { ...EMPTY_COUNTERS };
  }
}

/**
 * Read-modify-write the counters singleton. KV has no atomic increment, so
 * concurrent invocations can lose updates — accepted given KV's eventual
 * consistency and this app's low volume (see email-processor.ts storeEmail).
 * Never throws: counter failures must not break ingestion or admin flows.
 */
export async function bumpCounters(
  kv: KVNamespace,
  changes: Partial<Omit<Counters, "first_seen">>,
): Promise<void> {
  try {
    const current = await getCounters(kv);

    current.feeds_created += changes.feeds_created ?? 0;
    current.feeds_deleted += changes.feeds_deleted ?? 0;
    current.emails_received += changes.emails_received ?? 0;
    current.emails_rejected += changes.emails_rejected ?? 0;
    current.unsubscribes_sent += changes.unsubscribes_sent ?? 0;
    if (changes.last_email_at) current.last_email_at = changes.last_email_at;
    if (changes.last_feed_created_at)
      current.last_feed_created_at = changes.last_feed_created_at;
    if (!current.first_seen) current.first_seen = new Date().toISOString();

    await new CountersRepository(kv).put(current);
  } catch (error) {
    logger.error("Error updating counters", { error: String(error) });
  }
}

export async function countKeysByPrefix(
  kv: KVNamespace,
  prefix: string,
): Promise<number> {
  return new FeedRepository(kv).countKeysByPrefix(prefix);
}

export async function getStats(env: Env): Promise<StatsResponse> {
  const repo = FeedRepository.from(env);
  const [counters, feeds, websubCount] = await Promise.all([
    getCounters(env.EMAIL_STORAGE),
    repo.listFeeds(),
    WebSubSubscriptionRepository.from(env).countKeys(),
  ]);

  return {
    ...counters,
    active_feeds: feeds.length,
    websub_subscriptions_active: websubCount,
    attachments_enabled: !!getAttachmentBucket(env),
  };
}

/** Sum the byte size and object count of every attachment stored in R2. */
export async function scanR2Usage(
  bucket: R2Bucket,
): Promise<{ bytes: number; count: number }> {
  let bytes = 0;
  let count = 0;
  let cursor: string | undefined;
  try {
    do {
      const listed = await bucket.list({ cursor });
      for (const obj of listed.objects) {
        bytes += obj.size;
        count += 1;
      }
      cursor = listed.truncated ? listed.cursor : undefined;
    } while (cursor);
  } catch (error) {
    logger.error("Error scanning R2 usage", { error: String(error) });
  }
  return { bytes, count };
}

/**
 * Estimate KV storage used. KV exposes no size API, so we sum the per-email
 * sizes already recorded in each feed's metadata — email bodies dominate KV
 * usage. Feed config/websub/stats keys are excluded, so this is a lower-bound
 * estimate.
 */
export async function scanKvUsage(kv: KVNamespace): Promise<{ bytes: number }> {
  let bytes = 0;
  try {
    const repo = new FeedRepository(kv);
    const feeds = await repo.listFeeds();
    for (const feed of feeds) {
      const metadata = await repo.getMetadata(FeedId.unchecked(feed.id));
      if (!metadata) continue;
      for (const email of metadata.emails) {
        bytes += email.size ?? 0;
      }
    }
  } catch (error) {
    logger.error("Error estimating KV usage", { error: String(error) });
  }
  return { bytes };
}

/**
 * Overwrite the storage-usage snapshot fields on the counters singleton.
 * Unlike bumpCounters these are set (not incremented). Never throws.
 */
export async function setStorageSnapshot(
  kv: KVNamespace,
  snapshot: {
    attachments_bytes: number;
    attachments_count: number;
    kv_bytes_estimated: number;
  },
): Promise<void> {
  try {
    const current = await getCounters(kv);
    current.attachments_bytes = snapshot.attachments_bytes;
    current.attachments_count = snapshot.attachments_count;
    current.kv_bytes_estimated = snapshot.kv_bytes_estimated;
    current.storage_scanned_at = new Date().toISOString();
    if (!current.first_seen) current.first_seen = new Date().toISOString();
    await new CountersRepository(kv).put(current);
  } catch (error) {
    logger.error("Error writing storage snapshot", { error: String(error) });
  }
}
