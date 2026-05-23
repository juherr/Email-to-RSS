import { Counters, Env, StatsResponse } from "../types";
import { STATS_KEY } from "../config/constants";
import { logger } from "../lib/logger";
import { listAllFeeds } from "../routes/admin/helpers";

const EMPTY_COUNTERS: Counters = {
  feeds_created: 0,
  feeds_deleted: 0,
  emails_received: 0,
  emails_rejected: 0,
  unsubscribes_sent: 0,
};

export async function getCounters(kv: KVNamespace): Promise<Counters> {
  try {
    const stored = (await kv.get(STATS_KEY, {
      type: "json",
    })) as Counters | null;
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

    await kv.put(STATS_KEY, JSON.stringify(current));
  } catch (error) {
    logger.error("Error updating counters", { error: String(error) });
  }
}

export async function countKeysByPrefix(
  kv: KVNamespace,
  prefix: string,
): Promise<number> {
  let total = 0;
  let cursor: string | undefined;
  try {
    do {
      const listed = await kv.list({ prefix, cursor, limit: 1000 });
      total += listed.keys.length;
      cursor = listed.list_complete ? undefined : listed.cursor;
    } while (cursor);
  } catch (error) {
    logger.error("Error counting keys", { prefix, error: String(error) });
  }
  return total;
}

export async function getStats(env: Env): Promise<StatsResponse> {
  const kv = env.EMAIL_STORAGE;
  const [counters, feeds, websubCount] = await Promise.all([
    getCounters(kv),
    listAllFeeds(kv),
    countKeysByPrefix(kv, "websub:"),
  ]);

  return {
    ...counters,
    active_feeds: feeds.length,
    websub_subscriptions_active: websubCount,
  };
}
