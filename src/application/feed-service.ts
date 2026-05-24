import { Env, FeedConfig } from "../types";
import { bumpCounters } from "../application/stats";
import { dispatchFeedEvents } from "./feed-events";
import { sendUnsubscribes } from "../infrastructure/unsubscribe";
import { getAttachmentBucket } from "../infrastructure/attachments";
import { FeedRepository } from "../infrastructure/feed-repository";
import { toConfigDTO } from "../infrastructure/feed-mapper";
import { BackgroundScheduler } from "../infrastructure/worker";
import { FeedId } from "../domain/value-objects/feed-id";
import { MailboxId } from "../domain/value-objects/mailbox-id";
import { Lifetime } from "../domain/value-objects/lifetime";
import {
  Feed,
  CreateFeedInput,
  UpdateFeedInput,
} from "../domain/feed.aggregate";
import { purgeFeedKeysStep, collectUnsubscribeUrls } from "./feed-cleanup";

export type { CreateFeedInput, UpdateFeedInput };

/**
 * Resolve the effective feed `Lifetime` from a client request and the
 * server-side `FEED_TTL_HOURS` override. Parsing the env string and applying the
 * override is application/config policy — the domain only receives the resolved
 * VO. Returns `Lifetime.never` when the feed should never expire.
 */
function resolveLifetime(env: Env, requestedHours?: number): Lifetime {
  const hours = env.FEED_TTL_HOURS
    ? parseInt(env.FEED_TTL_HOURS, 10)
    : (requestedHours ?? NaN);
  return Number.isFinite(hours) && hours > 0
    ? Lifetime.ofHours(hours)
    : Lifetime.never;
}

/**
 * Create a feed: mint an opaque `FeedId` (the read id) and a friendly `MailboxId`
 * (the inbound address), write its config + empty metadata, register it in the
 * global list + inbound index, and bump the `feeds_created` counter. Returns the
 * new feed id, its mailbox, and config.
 */
export async function createFeedRecord(
  env: Env,
  input: CreateFeedInput,
): Promise<{ feedId: string; mailboxId: string; config: FeedConfig }> {
  const repo = FeedRepository.from(env);
  const feed = Feed.create(FeedId.generate(), input, {
    mailboxId: MailboxId.generate(),
    lifetime: resolveLifetime(env, input.lifetimeHours),
  });

  // save() also writes the inbound:<mailbox> → feedId index.
  await repo.save(feed);

  // FeedCreated → bumps the feeds_created counter (no background work to schedule).
  await dispatchFeedEvents(feed, env, () => {});

  return {
    feedId: feed.id.value,
    mailboxId: feed.mailboxId.value,
    config: toConfigDTO(feed.state()),
  };
}

export type UpdateFeedResult =
  | { status: "ok"; config: FeedConfig }
  | { status: "not_found" }
  | { status: "expired" };

/**
 * Quick-edit of title/description only — never recomputes expiry. Used by the
 * dashboard's minimal edit. Delegates to the aggregate's single `edit` path, so
 * an expired feed is rejected here too. The list projection is kept in sync by
 * the repository on `saveConfig`.
 */
export async function editFeedDetails(
  env: Env,
  feedId: FeedId,
  patch: { title?: string; description?: string },
): Promise<UpdateFeedResult> {
  const repo = FeedRepository.from(env);
  const feed = await repo.load(feedId);
  if (!feed) return { status: "not_found" };

  // No lifetime passed ⇒ expiry preserved (quick-edit never recomputes it).
  if (feed.edit(patch).status === "expired") {
    return { status: "expired" };
  }
  await repo.saveConfig(feed);

  return { status: "ok", config: toConfigDTO(feed.state()) };
}

/**
 * Full edit: apply the patch, recompute expiry, and reject expired feeds. Fields
 * left undefined are preserved. Mirrors title/description/expiry into the list.
 */
export async function editFeed(
  env: Env,
  feedId: FeedId,
  input: UpdateFeedInput,
): Promise<UpdateFeedResult> {
  const repo = FeedRepository.from(env);
  const feed = await repo.load(feedId);
  if (!feed) return { status: "not_found" };

  // Recompute expiry only when a server TTL or a client lifetime applies;
  // otherwise pass no lifetime so the aggregate preserves the current expiry.
  const lifetime =
    Boolean(env.FEED_TTL_HOURS) || input.lifetimeHours !== undefined
      ? resolveLifetime(env, input.lifetimeHours)
      : undefined;
  if (feed.edit(input, { lifetime }).status === "expired") {
    return { status: "expired" };
  }

  await repo.saveConfig(feed);

  return { status: "ok", config: toConfigDTO(feed.state()) };
}

type DeleteFeedFastResult = {
  ok: boolean;
  configDeleted: boolean;
  metadataDeleted: boolean;
  errors: string[];
};

/**
 * Delete a feed's config + metadata keys, reporting per-key outcomes. The larger
 * email/attachment cleanup is handled separately via purgeFeedKeysStep, and the
 * inbound `inbound:<mailbox>` index is dropped by `removeFromList(Bulk)` (which
 * every caller invokes next) — symmetric with `save()` writing it.
 */
export async function deleteFeedFastDetailed(
  emailStorage: KVNamespace,
  feedId: FeedId,
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
 * metadata, remove it from the list, bump the counter, and hand the background
 * unsubscribe requests + key purge to the supplied scheduler. Returns whether
 * the feed was present in the global list.
 */
export async function deleteFeedRecord(
  env: Env,
  feedId: FeedId,
  schedule: BackgroundScheduler,
): Promise<boolean> {
  const emailStorage = env.EMAIL_STORAGE;
  const repo = new FeedRepository(emailStorage);

  // Read unsubscribe URLs before the metadata is deleted below.
  const unsubscribeUrls = await collectUnsubscribeUrls(emailStorage, feedId);

  await deleteFeedFastDetailed(emailStorage, feedId);
  // removeFromList also drops the feed's inbound mailbox index.
  const removed = await repo.removeFromList(feedId);
  if (removed) {
    await bumpCounters(emailStorage, { feeds_deleted: 1 });
  }

  if (unsubscribeUrls.length > 0) {
    schedule(sendUnsubscribes(unsubscribeUrls, env));
  }

  schedule(
    purgeFeedKeysStep(emailStorage, feedId, {
      bucket: getAttachmentBucket(env),
    }),
  );

  return removed;
}
