import { Context } from "hono";
import { Env, FeedConfig } from "../types";
import { generateFeedId } from "../utils/id-generator";
import { bumpCounters } from "../utils/stats";
import { waitUntilSafe } from "../utils/worker";
import { sendUnsubscribes } from "../utils/unsubscribe";
import { getAttachmentBucket } from "../utils/attachments";
import { FeedRepository } from "../domain/feed-repository";
import { resolveExpiresAt, isExpired } from "../domain/feed";
import {
  Feed,
  CreateFeedInput,
  UpdateFeedInput,
} from "../domain/feed.aggregate";
import {
  purgeFeedKeysStep,
  collectUnsubscribeUrls,
} from "../routes/admin/helpers";

export type { CreateFeedInput, UpdateFeedInput };

/**
 * Create a feed: write its config + empty metadata, register it in the global
 * list, and bump the `feeds_created` counter. Returns the new feed id + config.
 */
export async function createFeedRecord(
  env: Env,
  input: CreateFeedInput,
): Promise<{ feedId: string; config: FeedConfig }> {
  const repo = FeedRepository.from(env);
  const feed = Feed.create(generateFeedId(), input, env);

  await repo.save(feed);
  await repo.addToList(
    feed.id,
    feed.config.title,
    feed.config.description,
    feed.config.expires_at,
  );

  await bumpCounters(env.EMAIL_STORAGE, {
    feeds_created: 1,
    last_feed_created_at: new Date().toISOString(),
  });

  return { feedId: feed.id, config: feed.config };
}

export type UpdateFeedResult =
  | { status: "ok"; config: FeedConfig }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Apply a partial patch to a feed's config and mirror title/description/expiry
 * into the global list. Fields left undefined on `input` are preserved.
 *
 * A full edit (default) rejects expired feeds and recomputes `expires_at` from
 * `FEED_TTL_HOURS`/`lifetimeHours`. `inPlace` skips both — used by the dashboard's
 * minimal title/description edit, which must never touch expiry.
 */
export async function updateFeedRecord(
  env: Env,
  feedId: string,
  input: UpdateFeedInput,
  options: { inPlace?: boolean } = {},
): Promise<UpdateFeedResult> {
  const repo = FeedRepository.from(env);

  const existing = await repo.getConfig(feedId);

  if (!existing) return { status: "not_found" };

  if (!options.inPlace && isExpired(existing)) {
    return { status: "expired" };
  }

  // Full edit recomputes expiry (FEED_TTL_HOURS or a supplied lifetime resets the
  // clock; an absent lifetime preserves it). In-place edits leave expiry alone.
  const expiresAt =
    !options.inPlace &&
    (env.FEED_TTL_HOURS || input.lifetimeHours !== undefined)
      ? resolveExpiresAt(env, input.lifetimeHours)
      : existing.expires_at;

  const config: FeedConfig = {
    ...existing,
    ...(input.title !== undefined ? { title: input.title } : {}),
    ...(input.description !== undefined
      ? { description: input.description }
      : {}),
    ...(input.language !== undefined ? { language: input.language } : {}),
    ...(input.allowedSenders !== undefined
      ? { allowed_senders: input.allowedSenders }
      : {}),
    ...(input.blockedSenders !== undefined
      ? { blocked_senders: input.blockedSenders }
      : {}),
    updated_at: Date.now(),
    expires_at: expiresAt,
  };

  await repo.putConfig(feedId, config);
  await repo.updateInList(feedId, config.title, config.description, expiresAt);

  return { status: "ok", config };
}

type DeleteFeedFastResult = {
  ok: boolean;
  configDeleted: boolean;
  metadataDeleted: boolean;
  errors: string[];
};

/**
 * Delete a feed's config + metadata keys, reporting per-key outcomes. The
 * larger email/attachment cleanup is handled separately via purgeFeedKeysStep.
 */
export async function deleteFeedFastDetailed(
  emailStorage: KVNamespace,
  feedId: string,
): Promise<DeleteFeedFastResult> {
  const repo = new FeedRepository(emailStorage);

  const errors: string[] = [];
  let configDeleted = false;
  let metadataDeleted = false;

  try {
    await repo.deleteConfig(feedId);
    configDeleted = true;
  } catch (error) {
    errors.push(`config delete failed: ${String(error)}`);
  }

  try {
    await repo.deleteMetadata(feedId);
    metadataDeleted = true;
  } catch (error) {
    errors.push(`metadata delete failed: ${String(error)}`);
  }

  return { ok: configDeleted, configDeleted, metadataDeleted, errors };
}

/**
 * Delete a single feed end-to-end: capture unsubscribe URLs, drop its config +
 * metadata, remove it from the list, bump the counter, and schedule background
 * unsubscribe requests + key purge via ctx.waitUntil. Returns whether the feed
 * was present in the global list.
 */
export async function deleteFeedRecord(
  c: Context<{ Bindings: Env }>,
  env: Env,
  feedId: string,
): Promise<boolean> {
  const emailStorage = env.EMAIL_STORAGE;
  const repo = new FeedRepository(emailStorage);

  // Read unsubscribe URLs before the metadata is deleted below.
  const unsubscribeUrls = await collectUnsubscribeUrls(emailStorage, feedId);

  await deleteFeedFastDetailed(emailStorage, feedId);
  const removed = await repo.removeFromList(feedId);
  if (removed) {
    await bumpCounters(emailStorage, { feeds_deleted: 1 });
  }

  if (unsubscribeUrls.length > 0) {
    waitUntilSafe(c, sendUnsubscribes(unsubscribeUrls, env));
  }

  waitUntilSafe(
    c,
    purgeFeedKeysStep(emailStorage, feedId, {
      bucket: getAttachmentBucket(env),
    }),
  );

  return removed;
}
