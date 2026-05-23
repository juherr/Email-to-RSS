import {
  EmailData,
  Env,
  FeedConfig,
  FeedList,
  FeedListItem,
  FeedMetadata,
} from "../types";
import { FEEDS_LIST_KEY } from "../config/constants";
import { feedKeys } from "./feed-keys";
import { Feed } from "./feed.aggregate";
import { FeedId } from "./value-objects/feed-id";
import { logger } from "../infrastructure/logger";

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

  /** Persist both keys the aggregate owns (config + metadata). */
  async save(feed: Feed): Promise<void> {
    await Promise.all([
      this.putConfig(feed.id, feed.config),
      this.putMetadata(feed.id, feed.metadata),
    ]);
  }

  /**
   * Persist only the email index. Used by the ingest/delete paths where config
   * is unchanged — avoids a redundant config write on the hot path.
   */
  async saveMetadata(feed: Feed): Promise<void> {
    await this.putMetadata(feed.id, feed.metadata);
  }

  /**
   * Persist only the config. Used by the rename/edit paths where metadata is
   * unchanged — avoids re-writing (and risking clobbering) the email index.
   */
  async saveConfig(feed: Feed): Promise<void> {
    await this.putConfig(feed.id, feed.config);
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

  async addToList(
    feedId: FeedId,
    title: string,
    description?: string,
    expires_at?: number,
  ): Promise<void> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null) || { feeds: [] };

      feedList.feeds.push({ id: feedId.value, title, description, expires_at });
      await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
    } catch (error) {
      logger.error("Error adding feed to list", {
        feedId: feedId.value,
        error: String(error),
      });
    }
  }

  async updateInList(
    feedId: FeedId,
    title: string,
    description?: string,
    expires_at?: number,
  ): Promise<void> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null) || { feeds: [] };

      const feedIndex = feedList.feeds.findIndex(
        (feed) => feed.id === feedId.value,
      );
      if (feedIndex !== -1) {
        feedList.feeds[feedIndex].title = title;
        feedList.feeds[feedIndex].description = description;
        feedList.feeds[feedIndex].expires_at = expires_at;
        await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
      }
    } catch (error) {
      logger.error("Error updating feed in list", {
        feedId: feedId.value,
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
