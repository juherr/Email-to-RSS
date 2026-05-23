import { EmailData, FeedList, FeedListItem } from "../../types";
import { FEEDS_LIST_KEY } from "../../config/constants";
import { logger } from "../../lib/logger";

export async function deleteKeysWithConcurrency(
  emailStorage: KVNamespace,
  keys: string[],
  concurrency: number,
): Promise<{ ok: string[]; failed: string[] }> {
  const uniqueKeys = Array.from(new Set(keys.filter(Boolean)));
  const ok: string[] = [];
  const failed: string[] = [];
  const limit = Math.max(1, Math.floor(concurrency) || 1);

  for (let i = 0; i < uniqueKeys.length; i += limit) {
    const batch = uniqueKeys.slice(i, i + limit);
    const results = await Promise.allSettled(
      batch.map((key) => emailStorage.delete(key)),
    );
    results.forEach((result, idx) => {
      const key = batch[idx];
      if (result.status === "fulfilled") {
        ok.push(key);
      } else {
        failed.push(key);
      }
    });
  }

  return { ok, failed };
}

export async function listAllFeeds(
  emailStorage: KVNamespace,
): Promise<FeedListItem[]> {
  try {
    const feedList = (await emailStorage.get(FEEDS_LIST_KEY, {
      type: "json",
    })) as FeedList | null;
    return feedList?.feeds || [];
  } catch (error) {
    logger.error("Error listing feeds", { error: String(error) });
    return [];
  }
}

export async function addFeedToList(
  emailStorage: KVNamespace,
  feedId: string,
  title: string,
  description?: string,
  expires_at?: number,
): Promise<void> {
  try {
    const feedList = ((await emailStorage.get(FEEDS_LIST_KEY, {
      type: "json",
    })) as FeedList | null) || { feeds: [] };

    feedList.feeds.push({ id: feedId, title, description, expires_at });
    await emailStorage.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
  } catch (error) {
    logger.error("Error adding feed to list", { feedId, error: String(error) });
  }
}

export async function updateFeedInList(
  emailStorage: KVNamespace,
  feedId: string,
  title: string,
  description?: string,
  expires_at?: number,
): Promise<void> {
  try {
    const feedList = ((await emailStorage.get(FEEDS_LIST_KEY, {
      type: "json",
    })) as FeedList | null) || { feeds: [] };

    const feedIndex = feedList.feeds.findIndex((feed) => feed.id === feedId);
    if (feedIndex !== -1) {
      feedList.feeds[feedIndex].title = title;
      feedList.feeds[feedIndex].description = description;
      feedList.feeds[feedIndex].expires_at = expires_at;
      await emailStorage.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
    }
  } catch (error) {
    logger.error("Error updating feed in list", {
      feedId,
      error: String(error),
    });
  }
}

export async function removeFeedsFromListBulk(
  emailStorage: KVNamespace,
  feedIds: string[],
): Promise<string[]> {
  try {
    const feedList = ((await emailStorage.get(FEEDS_LIST_KEY, {
      type: "json",
    })) as FeedList | null) || { feeds: [] };

    const toRemove = new Set(feedIds.filter(Boolean));
    if (toRemove.size === 0) return [];

    const removed: string[] = [];
    const nextFeeds: FeedListItem[] = [];

    for (const feed of feedList.feeds) {
      if (toRemove.has(feed.id)) {
        removed.push(feed.id);
        continue;
      }
      nextFeeds.push(feed);
    }

    if (removed.length === 0) return [];

    feedList.feeds = nextFeeds;
    await emailStorage.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
    return removed;
  } catch (error) {
    logger.error("Error removing feeds from list", { error: String(error) });
    return [];
  }
}

export async function removeFeedFromList(
  emailStorage: KVNamespace,
  feedId: string,
): Promise<boolean> {
  const removed = await removeFeedsFromListBulk(emailStorage, [feedId]);
  return removed.includes(feedId);
}

export async function purgeFeedKeysStep(
  emailStorage: KVNamespace,
  feedId: string,
  options: { cursor?: string; limit?: number; bucket?: R2Bucket } = {},
): Promise<{
  deletedKeys: string[];
  failedKeys: string[];
  cursor: string;
  listComplete: boolean;
}> {
  const prefix = `feed:${feedId}:`;
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit || 100)));
  const cursor = options.cursor || undefined;

  const listed = await emailStorage.list({ prefix, cursor, limit });
  const keys = (listed.keys || []).map((k) => k.name);

  if (options.bucket && keys.length > 0) {
    const emailKeys = keys.filter((k) => {
      const suffix = k.slice(prefix.length);
      return suffix !== "config" && suffix !== "metadata";
    });
    if (emailKeys.length > 0) {
      const emailDataResults = await Promise.allSettled(
        emailKeys.map(
          (k) =>
            emailStorage.get(k, { type: "json" }) as Promise<EmailData | null>,
        ),
      );
      const attachmentIds = emailDataResults
        .filter(
          (r): r is PromiseFulfilledResult<EmailData | null> =>
            r.status === "fulfilled",
        )
        .flatMap((r) => r.value?.attachments?.map((a) => a.id) ?? []);
      if (attachmentIds.length > 0) {
        await Promise.allSettled(
          attachmentIds.map((id) => options.bucket!.delete(id)),
        );
      }
    }
  }

  const { ok, failed } = await deleteKeysWithConcurrency(
    emailStorage,
    keys,
    35,
  );

  return {
    deletedKeys: ok,
    failedKeys: failed,
    cursor: listed.cursor || "",
    listComplete: !!listed.list_complete,
  };
}

export async function purgeExpiredFeeds(
  emailStorage: KVNamespace,
  feedId: string,
  bucket?: R2Bucket,
): Promise<void> {
  let cursor: string | undefined;
  do {
    const step = await purgeFeedKeysStep(emailStorage, feedId, {
      bucket,
      limit: 100,
      cursor,
    });
    cursor = step.listComplete ? undefined : step.cursor;
  } while (cursor);
}
