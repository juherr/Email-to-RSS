import { Env, WebSubSubscription } from "../types";
import { feedKeys } from "./feed-keys";
import { logger } from "../infrastructure/logger";

/**
 * KV access for per-feed WebSub subscriber lists (`websub:subs:<feedId>`).
 */
export class WebSubSubscriptionRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): WebSubSubscriptionRepository {
    return new WebSubSubscriptionRepository(env.EMAIL_STORAGE);
  }

  async get(feedId: string): Promise<WebSubSubscription[]> {
    const raw = await this.kv.get(feedKeys.websub(feedId), "json");
    return (raw as WebSubSubscription[] | null) ?? [];
  }

  async save(
    feedId: string,
    subscriptions: WebSubSubscription[],
  ): Promise<void> {
    await this.kv.put(feedKeys.websub(feedId), JSON.stringify(subscriptions));
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
