import { FEEDS_LIST_KEY, STATS_KEY } from "../config/constants";

/**
 * The KV key schema, in one pure place. Every repository builds its keys here so
 * the wire format lives in a single module — never inline a `feed:`/`icon:`/
 * `websub:` string elsewhere. Strings are byte-identical to the original schema;
 * changing them would require migrating live KV data.
 */

const WEBSUB_PREFIX = "websub:subs:";

export const feedKeys = {
  config: (feedId: string): string => `feed:${feedId}:config`,
  metadata: (feedId: string): string => `feed:${feedId}:metadata`,

  /** Prefix covering every key owned by a feed (config, metadata, emails). */
  feedPrefix: (feedId: string): string => `feed:${feedId}:`,

  /** Mint a fresh, time-ordered email key. Call once and reuse the result. */
  newEmail: (feedId: string): string => `feed:${feedId}:${Date.now()}`,

  /** KV key for a domain's cached favicon (shared across feeds). */
  icon: (domain: string): string => `icon:${domain}`,

  websub: (feedId: string): string => `${WEBSUB_PREFIX}${feedId}`,

  /** Prefix matching every per-feed WebSub subscription key. */
  websubPrefix: (): string => WEBSUB_PREFIX,

  /** True when `key` is an email entry (not the feed's config/metadata key). */
  isEmail: (feedId: string, key: string): boolean => {
    const suffix = key.slice(feedKeys.feedPrefix(feedId).length);
    return suffix !== "config" && suffix !== "metadata";
  },

  /** Recover the feed id embedded in an email key (`feed:<id>:<ts>`). */
  feedIdFromEmail: (key: string): string => key.split(":")[1],
} as const;

export { FEEDS_LIST_KEY, STATS_KEY };
