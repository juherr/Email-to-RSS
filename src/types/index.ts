// Global environment interface for Cloudflare Workers
export interface Env {
  EMAIL_STORAGE: KVNamespace;
  ADMIN_PASSWORD: string;
  DOMAIN: string;
  EMAIL_DOMAIN?: string;
  ATTACHMENT_BUCKET?: R2Bucket;
  ATTACHMENTS_ENABLED?: string; // "false" disables attachments even when R2 is bound
  FEED_MAX_SIZE_BYTES?: string;
  PROXY_TRUSTED_IPS?: string;
  PROXY_AUTH_SECRET?: string;
  FEED_TTL_HOURS?: string;
  // Optional catch-all fallback: non-feed inbound mail is forwarded here instead
  // of being dropped. Must be a *verified* Cloudflare Email Routing destination.
  FALLBACK_FORWARD_ADDRESS?: string;
}

// Stored attachment metadata (bytes live in R2, keyed by id)
export interface AttachmentData {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string; // Normalized Content-ID (no <>) used to resolve inline cid: refs
  // True when this attachment is an inline image referenced by a cid: URL in the
  // email body. Inline attachments render in place and are hidden from the
  // downloadable attachment lists, but are still stored in R2 and cleaned up.
  inline?: boolean;
}

// Email interface for stored emails
export interface EmailData {
  subject: string;
  from: string;
  content: string;
  receivedAt: number;
  headers: Record<string, string>;
  attachments?: AttachmentData[];
}

// Feed configuration interface
export interface FeedConfig {
  title: string;
  description?: string;
  // Inbound mailbox local part (noun.noun.NN): the feed's email address is
  // `mailbox_id@domain`. Decoupled from the feed's id (the opaque read id).
  mailbox_id: string;
  allowed_senders?: string[];
  blocked_senders?: string[];
  language: string;
  author?: string;
  created_at: number;
  updated_at?: number;
  expires_at?: number; // Unix timestamp ms — present when a TTL is configured
}

// Feed metadata interface
export interface FeedMetadata {
  emails: EmailMetadata[];
  iconDomain?: string; // Most recent sender's domain, used to resolve the feed icon
  // RFC 8058 one-click unsubscribe URLs, keyed by sender so each newsletter on
  // the feed keeps its own (latest) link; fired when the feed is deleted.
  unsubscribe?: Record<string, string>;
  // True while at least one unactioned confirmation email is present. Raised on
  // ingest, lowered by an admin "dismiss" or when the last confirmation email is
  // removed. Projected into feeds:list for the dashboard.
  pendingConfirmation?: boolean;
}

// Email metadata interface (summary info for listing)
export interface EmailMetadata {
  key: string;
  subject: string;
  receivedAt: number;
  size?: number;
  attachmentIds?: string[]; // Downloadable attachments (shown to the user)
  inlineAttachmentIds?: string[]; // Inline images: hidden from lists, still cleaned up
  messageId?: string; // RFC 2822 Message-ID header (dedup primary key)
  dedupHash?: string; // SHA-256 hex of normalized subject+content (dedup fallback)
  // Detected subscription-confirmation links (ranked top-3). Present ⇒ the email
  // was detected as a confirmation request.
  confirmation?: { links: string[] };
}

// Feed list interface
export interface FeedList {
  feeds: FeedListItem[];
}

// Feed summary interface (for the global feed list)
export interface FeedListItem {
  id: string;
  title: string;
  description?: string;
  mailbox_id: string; // Cached inbound address local part (admin/API display)
  expires_at?: number; // Cached from FeedConfig to avoid per-feed KV reads
  pendingConfirmation?: boolean; // Projected from FeedMetadata for the dashboard
}

// Cumulative monitoring counters (persisted as a KV singleton)
export interface Counters {
  feeds_created: number;
  feeds_deleted: number;
  emails_received: number;
  emails_rejected: number;
  // Subset of emails_rejected: non-feed mail forwarded to FALLBACK_FORWARD_ADDRESS
  // instead of dropped. Dropped count = emails_rejected − emails_forwarded.
  emails_forwarded: number;
  emails_deduplicated: number; // Duplicate deliveries silently skipped (not stored)
  unsubscribes_sent: number;
  last_email_at?: string; // ISO 8601
  last_feed_created_at?: string; // ISO 8601
  first_seen?: string; // ISO 8601 — first time counters were written (instance start)
  // Storage usage snapshot, refreshed by the hourly cron (overwritten, not incremented).
  attachments_bytes?: number; // Total R2 bytes used by attachments
  attachments_count?: number; // Number of R2 objects
  kv_bytes_estimated?: number; // Estimated KV bytes (sum of stored email sizes)
  storage_scanned_at?: string; // ISO 8601 — last storage scan
}

// Monitoring API response: persisted counters + live-computed values
export interface StatsResponse extends Counters {
  active_feeds: number;
  websub_subscriptions_active: number;
  attachments_enabled: boolean;
}

// WebSub (PubSubHubbub) subscription configuration
export interface WebSubSubscription {
  callbackUrl: string;
  secret?: string;
  expiresAt: number; // Unix timestamp ms
  format?: "rss" | "atom";
}

// Declare KVNamespace for TypeScript
declare global {
  // This is not an ideal solution but works for our example
  interface KVNamespace {
    get(key: string, options?: { type: "text" }): Promise<string | null>;
    get(key: string, options: { type: "json" }): Promise<unknown | null>;
    get(
      key: string,
      options: { type: "arrayBuffer" },
    ): Promise<ArrayBuffer | null>;
    get(
      key: string,
      options: { type: "stream" },
    ): Promise<ReadableStream | null>;
    put(
      key: string,
      value: string | ArrayBuffer | ReadableStream | FormData,
      options?: { expirationTtl?: number; expiration?: number },
    ): Promise<void>;
    delete(key: string): Promise<void>;
    list(options?: {
      prefix?: string;
      limit?: number;
      cursor?: string;
    }): Promise<{
      keys: { name: string; expiration?: number }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  }
}
