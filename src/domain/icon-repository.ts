import { Env } from "../types";
import { feedKeys } from "./feed-keys";

/**
 * KV access for cached per-domain favicons (`icon:<domain>`). Entries may be
 * positive (base64 bytes) or negative (a sentinel marking a failed fetch), and
 * always carry a TTL — the cache's sole expiry mechanism.
 */
export class IconRepository {
  constructor(private readonly kv: KVNamespace) {}

  static from(env: Env): IconRepository {
    return new IconRepository(env.EMAIL_STORAGE);
  }

  getText(domain: string): Promise<string | null> {
    return this.kv.get(feedKeys.icon(domain), "text");
  }

  async getJson<T>(domain: string): Promise<T | null> {
    return (await this.kv.get(feedKeys.icon(domain), {
      type: "json",
    })) as T | null;
  }

  async put(domain: string, value: string, ttlSeconds: number): Promise<void> {
    await this.kv.put(feedKeys.icon(domain), value, {
      expirationTtl: ttlSeconds,
    });
  }
}
