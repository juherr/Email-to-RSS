import { Counters, Env } from "../types";
import { STATS_KEY } from "./feed-keys";

/**
 * KV access for the monitoring counters singleton (`stats:counters`). The
 * increment policy lives in the application layer (utils/stats.ts); this
 * repository owns only the raw read/write of the blob.
 */
export class CountersRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): CountersRepository {
    return new CountersRepository(env.EMAIL_STORAGE);
  }

  async getRaw(): Promise<Counters | null> {
    return (await this.kv.get(STATS_KEY, { type: "json" })) as Counters | null;
  }

  async put(counters: Counters): Promise<void> {
    await this.kv.put(STATS_KEY, JSON.stringify(counters));
  }
}
