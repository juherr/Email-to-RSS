import { EmailData, EmailMetadata, Env } from "../../types";
import { logger } from "../../infrastructure/logger";
import { getAttachmentBucket } from "../../infrastructure/attachments";
import { FeedRepository } from "../../infrastructure/feed-repository";
import { FeedId } from "../../domain/value-objects/feed-id";

// Delete the R2 attachments belonging to the given email keys. Call before the
// emails are removed from feed metadata, while `emails` still carries their
// attachmentIds.
export async function deleteAttachmentsForEmails(
  env: Env,
  emails: EmailMetadata[],
  keys: Iterable<string>,
): Promise<void> {
  const keySet = new Set(keys);
  const attachmentIds = emails
    .filter((e) => keySet.has(e.key))
    .flatMap((e) => e.attachmentIds ?? []);
  if (attachmentIds.length === 0) return;

  const bucket = getAttachmentBucket(env);
  if (!bucket) return;

  await Promise.allSettled(attachmentIds.map((id) => bucket.delete(id)));
}

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

/**
 * Read a feed's stored RFC 8058 one-click unsubscribe URLs (one per sender).
 * Must be called before the feed metadata is deleted. Never throws.
 */
export async function collectUnsubscribeUrls(
  emailStorage: KVNamespace,
  feedId: string,
): Promise<string[]> {
  try {
    const metadata = await new FeedRepository(emailStorage).getMetadata(
      FeedId.fromTrusted(feedId),
    );
    return Object.values(metadata?.unsubscribe ?? {});
  } catch (error) {
    logger.error("Error reading unsubscribe URLs", {
      feedId,
      error: String(error),
    });
    return [];
  }
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
  const repo = new FeedRepository(emailStorage);
  const id = FeedId.fromTrusted(feedId);
  const listed = await repo.listFeedKeys(id, {
    cursor: options.cursor,
    limit: options.limit,
  });
  const keys = listed.names;

  if (options.bucket && keys.length > 0) {
    const emailKeys = keys.filter((k) => repo.isEmailKey(id, k));
    if (emailKeys.length > 0) {
      const emailDataResults = await Promise.allSettled(
        emailKeys.map((k) => repo.getEmail(k)),
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
    cursor: listed.cursor,
    listComplete: listed.listComplete,
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
