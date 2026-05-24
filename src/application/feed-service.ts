import { Context } from "hono";
import { Env, FeedConfig } from "../types";
import { bumpCounters } from "../application/stats";
import { waitUntilSafe } from "../infrastructure/worker";
import { sendUnsubscribes } from "../infrastructure/unsubscribe";
import { getAttachmentBucket } from "../infrastructure/attachments";
import { FeedRepository } from "../domain/feed-repository";
import { FeedId } from "../domain/value-objects/feed-id";
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
 * Resolve the effective feed lifetime (hours) from a client request and the
 * server-side `FEED_TTL_HOURS` override. Parsing the env string and applying the
 * override is application/config policy — the domain only receives the resolved
 * number. Returns undefined when the feed should never expire.
 */
function resolveTtlHours(
  env: Env,
  requestedHours?: number,
): number | undefined {
  const hours = env.FEED_TTL_HOURS
    ? parseInt(env.FEED_TTL_HOURS, 10)
    : (requestedHours ?? NaN);
  return Number.isFinite(hours) && hours > 0 ? hours : undefined;
}

/**
 * Create a feed: write its config + empty metadata, register it in the global
 * list, and bump the `feeds_created` counter. Returns the new feed id + config.
 */
export async function createFeedRecord(
  env: Env,
  input: CreateFeedInput,
): Promise<{ feedId: string; config: FeedConfig }> {
  const repo = FeedRepository.from(env);
  const feed = Feed.create(FeedId.generate(), input, {
    ttlHours: resolveTtlHours(env, input.lifetimeHours),
  });

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

  return { feedId: feed.id.value, config: feed.config };
}

export type UpdateFeedResult =
  | { status: "ok"; config: FeedConfig }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * In-place edit of title/description only — never touches expiry. Used by the
 * dashboard's minimal edit. Mirrors the new title/description into the list.
 */
export async function renameFeed(
  env: Env,
  feedId: string,
  patch: { title?: string; description?: string },
): Promise<UpdateFeedResult> {
  const repo = FeedRepository.from(env);
  const feed = await repo.load(FeedId.fromTrusted(feedId));
  if (!feed) return { status: "not_found" };

  feed.rename(patch);
  await repo.saveConfig(feed);
  await repo.updateInList(
    feed.id,
    feed.config.title,
    feed.config.description,
    feed.config.expires_at,
  );

  return { status: "ok", config: feed.config };
}

/**
 * Full edit: apply the patch, recompute expiry, and reject expired feeds. Fields
 * left undefined are preserved. Mirrors title/description/expiry into the list.
 */
export async function editFeed(
  env: Env,
  feedId: string,
  input: UpdateFeedInput,
): Promise<UpdateFeedResult> {
  const repo = FeedRepository.from(env);
  const feed = await repo.load(FeedId.fromTrusted(feedId));
  if (!feed) return { status: "not_found" };

  const recomputeExpiry =
    Boolean(env.FEED_TTL_HOURS) || input.lifetimeHours !== undefined;
  if (
    feed.edit(input, {
      recomputeExpiry,
      ttlHours: resolveTtlHours(env, input.lifetimeHours),
    }).status === "expired"
  ) {
    return { status: "expired" };
  }

  await repo.saveConfig(feed);
  await repo.updateInList(
    feed.id,
    feed.config.title,
    feed.config.description,
    feed.config.expires_at,
  );

  return { status: "ok", config: feed.config };
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
  const id = FeedId.fromTrusted(feedId);

  const errors: string[] = [];
  let configDeleted = false;
  let metadataDeleted = false;

  try {
    await repo.deleteConfig(id);
    configDeleted = true;
  } catch (error) {
    errors.push(`config delete failed: ${String(error)}`);
  }

  try {
    await repo.deleteMetadata(id);
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
  const removed = await repo.removeFromList(FeedId.fromTrusted(feedId));
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
