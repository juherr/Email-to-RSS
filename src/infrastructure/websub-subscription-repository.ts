import { Env, WebSubSubscription } from "../types";
import { feedKeys } from "../domain/feed-keys";
import { FeedId } from "../domain/value-objects/feed-id";
import { logger } from "./logger";

/**
 * KV access for per-feed WebSub subscriber lists (`websub:subs:<feedId>`).
 */
export class WebSubSubscriptionRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): WebSubSubscriptionRepository {
    return new WebSubSubscriptionRepository(env.EMAIL_STORAGE);
  }

  async get(feedId: FeedId): Promise<WebSubSubscription[]> {
    const raw = await this.kv.get(feedKeys.websub(feedId.value), "json");
    return (raw as WebSubSubscription[] | null) ?? [];
  }

  async save(
    feedId: FeedId,
    subscriptions: WebSubSubscription[],
  ): Promise<void> {
    await this.kv.put(
      feedKeys.websub(feedId.value),
      JSON.stringify(subscriptions),
    );
  }

  /** Number of feeds that currently hold at least one WebSub subscription. */
  async countKeys(): Promise<number> {
    const prefix = feedKeys.websubPrefix();
    let total = 0;
    let cursor: string | undefined;
    try {
      do {
        const listed = await this.kv.list({ prefix, cursor, limit: 1000 });
        total += listed.keys.length;
        cursor = listed.list_complete ? undefined : listed.cursor;
      } while (cursor);
    } catch (error) {
      logger.error("Error counting subscription keys", {
        error: String(error),
      });
    }
    return total;
  }
}
