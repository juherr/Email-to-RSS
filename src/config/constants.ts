/** Maximum total size of emails stored per feed (bytes). */
export const FEED_MAX_BYTES = 524288; // 512 KB

/** Cloudflare R2 free tier storage allowance (bytes). */
export const R2_FREE_TIER_BYTES = 10 * 1024 ** 3; // 10 GB

/** Cloudflare KV free tier storage allowance (bytes). */
export const KV_FREE_TIER_BYTES = 1 * 1024 ** 3; // 1 GB

/** Cache TTL for ForwardEmail.net IP list (milliseconds). */
export const FORWARD_EMAIL_IPS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Admin session cookie max-age (seconds). */
export const ADMIN_COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 1 week

/** Maximum number of feed items exposed in RSS/Atom responses. */
export const MAX_FEED_ITEMS = 20;

/** Default WebSub lease duration (seconds). */
export const DEFAULT_LEASE_SECONDS = 86400; // 24 hours

/** Maximum WebSub lease duration (seconds). */
export const MAX_LEASE_SECONDS = 30 * 24 * 3600; // 30 days

/** KV key for the global feed list. */
export const FEEDS_LIST_KEY = "feeds:list";

/** KV key for the monitoring counters singleton. */
export const STATS_KEY = "stats:counters";

/** Default TTL for a cached per-domain favicon (seconds). */
export const ICON_TTL_SECONDS = 7 * 24 * 60 * 60; // 1 week

/**
 * TTL for a *negative* favicon cache entry (seconds). Kept short so a transient
 * miss (e.g. DuckDuckGo not having indexed the domain yet) self-heals within
 * hours instead of blacklisting the domain for a full week.
 */
export const ICON_NEGATIVE_TTL_SECONDS = 6 * 60 * 60; // 6 hours

/**
 * Maximum accepted favicon size (bytes); larger responses are rejected.
 * DuckDuckGo serves hi-res (often 144×144) PNG favicons that legitimately
 * exceed 100 KB, so the cap is generous; KV's value limit (25 MB) is the only
 * hard constraint, even after base64 inflation.
 */
export const MAX_ICON_BYTES = 256 * 1024; // 256 KB

/** Timeout for an outbound favicon fetch (milliseconds). */
export const ICON_FETCH_TIMEOUT_MS = 5000;

/** Timeout for an outbound RFC 8058 one-click unsubscribe request (milliseconds). */
export const UNSUBSCRIBE_TIMEOUT_MS = 5000;
