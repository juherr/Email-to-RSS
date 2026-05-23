import {
  Counters,
  EmailData,
  Env,
  FeedConfig,
  FeedList,
  FeedListItem,
  FeedMetadata,
  WebSubSubscription,
} from "../types";
import { FEEDS_LIST_KEY, STATS_KEY } from "../config/constants";
import { logger } from "../lib/logger";

const WEBSUB_PREFIX = "websub:subs:";

/**
 * Single source of truth for the KV key schema and all KV access. No other
 * module should build a `feed:`/`feeds:list`/`websub:`/`icon:`/`stats:counters`
 * key string — go through a repository method instead.
 *
 * Wraps one `KVNamespace`; construct per request via `FeedRepository.from(env)`.
 */
export class FeedRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): FeedRepository {
    return new FeedRepository(env.EMAIL_STORAGE);
  }

  // ── Key schema ────────────────────────────────────────────────────────────

  private configKey(feedId: string): string {
    return `feed:${feedId}:config`;
  }

  private metadataKey(feedId: string): string {
    return `feed:${feedId}:metadata`;
  }

  /** KV key for a domain's cached favicon (shared across feeds). */
  iconKey(domain: string): string {
    return `icon:${domain}`;
  }

  private websubKey(feedId: string): string {
    return `${WEBSUB_PREFIX}${feedId}`;
  }

  /** Prefix covering every key owned by a feed (config, metadata, emails). */
  feedKeyPrefix(feedId: string): string {
    return `feed:${feedId}:`;
  }

  /** Mint a fresh, time-ordered email key. Call once and reuse the result. */
  newEmailKey(feedId: string): string {
    return `feed:${feedId}:${Date.now()}`;
  }

  /** True when `key` is an email entry (not the feed's config/metadata key). */
  isEmailKey(feedId: string, key: string): boolean {
    const suffix = key.slice(this.feedKeyPrefix(feedId).length);
    return suffix !== "config" && suffix !== "metadata";
  }

  /** Recover the feed id embedded in an email key (`feed:<id>:<ts>`). */
  feedIdFromEmailKey(key: string): string {
    return key.split(":")[1];
  }

  // ── Feed config ───────────────────────────────────────────────────────────

  async getConfig(feedId: string): Promise<FeedConfig | null> {
    return (await this.kv.get(this.configKey(feedId), {
      type: "json",
    })) as FeedConfig | null;
  }

  async putConfig(feedId: string, config: FeedConfig): Promise<void> {
    await this.kv.put(this.configKey(feedId), JSON.stringify(config));
  }

  async deleteConfig(feedId: string): Promise<void> {
    await this.kv.delete(this.configKey(feedId));
  }

  // ── Feed metadata ─────────────────────────────────────────────────────────

  async getMetadata(feedId: string): Promise<FeedMetadata | null> {
    return (await this.kv.get(this.metadataKey(feedId), {
      type: "json",
    })) as FeedMetadata | null;
  }

  async putMetadata(feedId: string, metadata: FeedMetadata): Promise<void> {
    await this.kv.put(this.metadataKey(feedId), JSON.stringify(metadata));
  }

  async deleteMetadata(feedId: string): Promise<void> {
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
    feedId: string,
    title: string,
    description?: string,
    expires_at?: number,
  ): Promise<void> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null) || { feeds: [] };

      feedList.feeds.push({ id: feedId, title, description, expires_at });
      await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
    } catch (error) {
      logger.error("Error adding feed to list", {
        feedId,
        error: String(error),
      });
    }
  }

  async updateInList(
    feedId: string,
    title: string,
    description?: string,
    expires_at?: number,
  ): Promise<void> {
    try {
      const feedList = ((await this.kv.get(FEEDS_LIST_KEY, {
        type: "json",
      })) as FeedList | null) || { feeds: [] };

      const feedIndex = feedList.feeds.findIndex((feed) => feed.id === feedId);
      if (feedIndex !== -1) {
        feedList.feeds[feedIndex].title = title;
        feedList.feeds[feedIndex].description = description;
        feedList.feeds[feedIndex].expires_at = expires_at;
        await this.kv.put(FEEDS_LIST_KEY, JSON.stringify(feedList));
      }
    } catch (error) {
      logger.error("Error updating feed in list", {
        feedId,
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

  async removeFromList(feedId: string): Promise<boolean> {
    const removed = await this.removeFromListBulk([feedId]);
    return removed.includes(feedId);
  }

  // ── Key listing / counting ────────────────────────────────────────────────

  async listFeedKeys(
    feedId: string,
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

  /** Number of feeds that currently hold at least one WebSub subscription. */
  countSubscriptionKeys(): Promise<number> {
    return this.countKeysByPrefix("websub:");
  }

  // ── Monitoring counters ───────────────────────────────────────────────────

  async getCountersRaw(): Promise<Counters | null> {
    return (await this.kv.get(STATS_KEY, { type: "json" })) as Counters | null;
  }

  async putCounters(counters: Counters): Promise<void> {
    await this.kv.put(STATS_KEY, JSON.stringify(counters));
  }

  // ── Favicons ──────────────────────────────────────────────────────────────

  async getIconText(domain: string): Promise<string | null> {
    return this.kv.get(this.iconKey(domain), "text");
  }

  async getIconJson<T>(domain: string): Promise<T | null> {
    return (await this.kv.get(this.iconKey(domain), {
      type: "json",
    })) as T | null;
  }

  async putIcon(
    domain: string,
    value: string,
    ttlSeconds: number,
  ): Promise<void> {
    await this.kv.put(this.iconKey(domain), value, {
      expirationTtl: ttlSeconds,
    });
  }

  // ── WebSub subscriptions ──────────────────────────────────────────────────

  async getSubscriptions(feedId: string): Promise<WebSubSubscription[]> {
    const raw = await this.kv.get(this.websubKey(feedId), "json");
    return (raw as WebSubSubscription[] | null) ?? [];
  }

  async saveSubscriptions(
    feedId: string,
    subscriptions: WebSubSubscription[],
  ): Promise<void> {
    await this.kv.put(this.websubKey(feedId), JSON.stringify(subscriptions));
  }
}
