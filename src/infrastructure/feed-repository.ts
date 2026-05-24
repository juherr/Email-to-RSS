import {
  EmailData,
  Env,
  FeedConfig,
  FeedList,
  FeedListItem,
  FeedMetadata,
} from "../types";
import { FEEDS_LIST_KEY } from "../config/constants";
import { feedKeys } from "../domain/feed-keys";
import { Feed } from "../domain/feed.aggregate";
import { FeedId } from "../domain/value-objects/feed-id";
import { logger } from "./logger";

/**
 * Single source of truth for KV access to the Feed aggregate. The key schema
 * itself lives in `feed-keys.ts`; this repository owns the get/put operations.
 * No other module should build a `feed:`/`feeds:list`/`websub:`/`icon:`/
 * `stats:counters` key string — go through `feed-keys` or a repository method.
 *
 * Wraps one `KVNamespace`; construct per request via `FeedRepository.from(env)`.
 */
export class FeedRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): FeedRepository {
    return new FeedRepository(env.EMAIL_STORAGE);
  }

  // ── Key schema (delegates to feed-keys) ───────────────────────────────────

  private configKey(feedId: FeedId): string {
    return feedKeys.config(feedId.value);
  }

  private metadataKey(feedId: FeedId): string {
    return feedKeys.metadata(feedId.value);
  }

  /** Prefix covering every key owned by a feed (config, metadata, emails). */
  feedKeyPrefix(feedId: FeedId): string {
    return feedKeys.feedPrefix(feedId.value);
  }

  /** Mint a fresh, time-ordered email key. Call once and reuse the result. */
  newEmailKey(feedId: FeedId): string {
    return feedKeys.newEmail(feedId.value);
  }

  /** True when `key` is an email entry (not the feed's config/metadata key). */
  isEmailKey(feedId: FeedId, key: string): boolean {
    return feedKeys.isEmail(feedId.value, key);
  }

  /** Recover the feed id embedded in an email key (`feed:<id>:<ts>`). */
  feedIdFromEmailKey(key: string): string {
    return feedKeys.feedIdFromEmail(key);
  }

  // ── Feed aggregate ────────────────────────────────────────────────────────

  /**
   * Load the aggregate (config + email index). A feed exists iff it has a
   * config; metadata defaults to empty so a freshly-created feed still loads.
   */
  async load(feedId: FeedId): Promise<Feed | null> {
    const [config, metadata] = await Promise.all([
      this.getConfig(feedId),
      this.getMetadata(feedId),
    ]);
    if (!config) return null;
    return Feed.reconstitute(feedId, config, metadata ?? { emails: [] });
  }

  /**
   * Persist both keys the aggregate owns (config + metadata) and keep the global
   * `feeds:list` entry in sync. The registry projection is derived from
   * `feed.summary()` here, so no caller has to remember to mirror it.
   */
  async save(feed: Feed): Promise<void> {
    await Promise.all([
      this.putConfig(feed.id, feed.toConfigSnapshot()),
      this.putMetadata(feed.id, feed.toMetadataSnapshot()),
      this.upsertListEntry(feed.summary()),
    ]);
  }

  /**
   * Persist only the email index. Used by the ingest/delete paths where config
   * is unchanged — avoids a redundant config write on the hot path. The list
   * projection (title/description/expiry) is untouched, so it is not rewritten.
   */
  async saveMetadata(feed: Feed): Promise<void> {
    await this.putMetadata(feed.id, feed.toMetadataSnapshot());
  }

  /**
   * Persist only the config and refresh the `feeds:list` entry from it. Used by
   * the rename/edit paths where metadata is unchanged — avoids re-writing (and
   * risking clobbering) the email index.
   */
  async saveConfig(feed: Feed): Promise<void> {
    await Promise.all([
      this.putConfig(feed.id, feed.toConfigSnapshot()),
      this.upsertListEntry(feed.summary()),
    ]);
  }

  // ── Feed config ───────────────────────────────────────────────────────────

  async getConfig(feedId: FeedId): Promise<FeedConfig | null> {
    return (await this.kv.get(this.configKey(feedId), {
      type: "json",
    })) as FeedConfig | null;
  }

  async putConfig(feedId: FeedId, config: FeedConfig): Promise<void> {
    await this.kv.put(this.configKey(feedId), JSON.stringify(config));
  }

  async deleteConfig(feedId: FeedId): Promise<void> {
    await this.kv.delete(this.configKey(feedId));
  }

  // ── Feed metadata ─────────────────────────────────────────────────────────

  async getMetadata(feedId: FeedId): Promise<FeedMetadata | null> {
    return (await this.kv.get(this.metadataKey(feedId), {
      type: "json",
    })) as FeedMetadata | null;
  }

  async putMetadata(feedId: FeedId, metadata: FeedMetadata): Promise<void> {
    await this.kv.put(this.metadataKey(feedId), JSON.stringify(metadata));
  }

  async deleteMetadata(feedId: FeedId): Promise<void> {
    await this.kv.delete(this.metadataKey(feedId));
  }

  // ── Emails ────────────────────────────────────────────────────────────────

  async putEmail(key: string, data: EmailData): Promise<void> {
    await this.kv.put(key, JSON.stringify(data));
  }

  async getEmail(key: string): Promise<EmailData | null> {
    return (await this.kv.get(key, { type: "json" })) as EmailData | null;
  }

  async deleteEmail(key: string): Promise<void> {
    await this.kv.delete(key);
  }

  // ── Global feed list ──────────────────────────────────────────────────────

  async listFeeds(): Promise<FeedListItem[]> {
    try {
      const feedList = (await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null;
      return feedList?.feeds || [];
    } catch (error) {
      logger.error("Error listing feeds", { error: String(error) });
      return [];
    }
  }

  /**
   * Insert-or-update a feed's entry in the global `feeds:list` registry from its
   * aggregate summary. Idempotent by feed id. Private: callers persist a `Feed`
   * via `save`/`saveConfig`, which keep the projection in sync — never mirror the
   * list by hand. (Read-modify-write is not atomic under KV, unchanged from the
   * prior add/update split.)
   */
  private async upsertListEntry(summary: FeedListItem): Promise<void> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null) || { feeds: [] };

      const index = feedList.feeds.findIndex((feed) => feed.id === summary.id);
      if (index === -1) {
        feedList.feeds.push(summary);
      } else {
        feedList.feeds[index] = summary;
      }
      await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
    } catch (error) {
      logger.error("Error upserting feed in list", {
        feedId: summary.id,
        error: String(error),
      });
    }
  }

  async removeFromListBulk(feedIds: string[]): Promise<string[]> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
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
      await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
      return removed;
    } catch (error) {
      logger.error("Error removing feeds from list", { error: String(error) });
      return [];
    }
  }

  async removeFromList(feedId: FeedId): Promise<boolean> {
    const removed = await this.removeFromListBulk([feedId.value]);
    return removed.includes(feedId.value);
  }

  // ── Key listing / counting ────────────────────────────────────────────────

  async listFeedKeys(
    feedId: FeedId,
    options: { cursor?: string; limit?: number } = {},
  ): Promise<{ names: string[]; cursor: string; listComplete: boolean }> {
    const prefix = this.feedKeyPrefix(feedId);
    const limit = Math.min(1000, Math.max(1, Math.floor(options.limit || 100)));
    const cursor = options.cursor || undefined;

    const listed = await this.kv.list({ prefix, cursor, limit });
    return {
      names: (listed.keys || []).map((k) => k.name),
      cursor: listed.cursor || "",
      listComplete: !!listed.list_complete,
    };
  }

  async countKeysByPrefix(prefix: string): Promise<number> {
    let total = 0;
    let cursor: string | undefined;
    try {
      do {
        const listed = await this.kv.list({ prefix, cursor, limit: 1000 });
        total += listed.keys.length;
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    } catch (error) {
      logger.error("Error counting keys", { prefix, error: String(error) });
    }
    return total;
  }
}
