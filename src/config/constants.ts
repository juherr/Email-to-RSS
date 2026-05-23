/** Maximum total size of emails stored per feed (bytes). */
export const FEED_MAX_BYTES = 524288; // 512 KB

/** Cache TTL for ForwardEmail.net IP list (milliseconds). */
export const FORWARD_EMAIL_IPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Admin session cookie max-age (seconds). */
export const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 1 week

/** Maximum number of feed items exposed in RSS/Atom responses. */
export const MAX_FEED_ITEMS = 20;

/** Maximum number of email entries kept in feed metadata. */
export const MAX_METADATA_EMAILS = 50;

/** Default WebSub lease duration (seconds). */
export const DEFAULT_LEASE_SECONDS = 86400; // 24 hours

/** Maximum WebSub lease duration (seconds). */
export const MAX_LEASE_SECONDS = 30 * 24 * 3600; // 30 days

/** KV key for the global feed list. */
export const FEEDS_LIST_KEY = "feeds:list";

/** KV key for the monitoring counters singleton. */
export const STATS_KEY = "stats:counters";
