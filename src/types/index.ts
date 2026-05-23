// Global environment interface for Cloudflare Workers
export interface Env {
  EMAIL_STORAGE: KVNamespace;
  ADMIN_PASSWORD: string;
  DOMAIN: string;
  EMAIL_DOMAIN?: string;
  ATTACHMENT_BUCKET?: R2Bucket;
  FEED_MAX_SIZE_BYTES?: string;
  PROXY_TRUSTED_IPS?: string;
  PROXY_AUTH_SECRET?: string;
  FEED_TTL_HOURS?: string;
}

// Stored attachment metadata (bytes live in R2, keyed by id)
export interface AttachmentData {
  id: string;
  filename: string;
  contentType: string;
  size: number;
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
}

// Email metadata interface (summary info for listing)
export interface EmailMetadata {
  key: string;
  subject: string;
  receivedAt: number;
  size?: number;
  attachmentIds?: string[];
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
  expires_at?: number; // Cached from FeedConfig to avoid per-feed KV reads
}

// Cumulative monitoring counters (persisted as a KV singleton)
export interface Counters {
  feeds_created: number;
  feeds_deleted: number;
  emails_received: number;
  emails_rejected: number;
  last_email_at?: string; // ISO 8601
  last_feed_created_at?: string; // ISO 8601
  first_seen?: string; // ISO 8601 — first time counters were written (instance start)
}

// Monitoring API response: persisted counters + live-computed values
export interface StatsResponse extends Counters {
  active_feeds: number;
  websub_subscriptions_active: number;
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
