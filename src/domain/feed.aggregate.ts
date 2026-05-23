import { Env, FeedConfig, FeedMetadata, EmailMetadata } from "../types";
import {
  resolveExpiresAt,
  isExpired,
  applySenderPolicy,
  trimToByteBudget,
  SenderDecision,
} from "./feed";

export interface CreateFeedInput {
  title: string;
  description?: string;
  language: string;
  allowedSenders: string[];
  blockedSenders: string[];
  lifetimeHours?: number;
}

export interface UpdateFeedInput {
  title?: string;
  description?: string;
  language?: string;
  allowedSenders?: string[];
  blockedSenders?: string[];
  lifetimeHours?: number;
}

export interface IngestOptions {
  maxBytes: number;
  iconDomain?: string;
  /** RFC 8058 one-click unsubscribe link, keyed by the sending newsletter. */
  unsub?: { senderKey: string; url: string };
}

/**
 * The Feed aggregate: the consistency boundary around a feed's config and the
 * metadata index of its emails. All mutations to either go through a method
 * here so the invariants (expiry policy, sender policy, byte budget) live in one
 * place. Email bodies are large blobs referenced by `metadata.emails[].key` and
 * deliberately sit *outside* the aggregate — the caller flushes them alongside
 * `FeedRepository.save`/`saveMetadata`.
 *
 * I/O-free: load and persist state through `FeedRepository`. KV has no multi-key
 * transaction, so a future Durable Object keyed by feed id would wrap
 * load→mutate→save to serialise concurrent writers (see email-processor.ts).
 */
export class Feed {
  private constructor(
    readonly id: string,
    private _config: FeedConfig,
    private _metadata: FeedMetadata,
  ) {}

  /** Mint a brand-new feed with an empty email index. */
  static create(id: string, input: CreateFeedInput, env: Env): Feed {
    const now = Date.now();
    const expiresAt = resolveExpiresAt(env, input.lifetimeHours);
    const config: FeedConfig = {
      title: input.title,
      description: input.description,
      language: input.language,
      allowed_senders: input.allowedSenders,
      blocked_senders: input.blockedSenders,
      created_at: now,
      updated_at: now,
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    };
    return new Feed(id, config, { emails: [] });
  }

  /** Rebuild an aggregate from persisted state. */
  static reconstitute(
    id: string,
    config: FeedConfig,
    metadata: FeedMetadata,
  ): Feed {
    return new Feed(id, config, metadata);
  }

  get config(): Readonly<FeedConfig> {
    return this._config;
  }

  get metadata(): Readonly<FeedMetadata> {
    return this._metadata;
  }

  isExpired(now: number = Date.now()): boolean {
    return isExpired(this._config, now);
  }

  accepts(senders: string[]): SenderDecision {
    return applySenderPolicy(this._config, senders);
  }

  /**
   * Add an email to the front of the index, refresh the icon domain and the
   * per-sender unsubscribe link, then trim the oldest entries back under the
   * byte budget. Returns the dropped entries so the caller can purge their
   * bodies/attachments.
   */
  ingest(
    entry: EmailMetadata,
    opts: IngestOptions,
  ): { dropped: EmailMetadata[] } {
    this._metadata.emails.unshift(entry);

    if (opts.iconDomain) {
      this._metadata.iconDomain = opts.iconDomain;
    }
    if (opts.unsub) {
      this._metadata.unsubscribe = {
        ...(this._metadata.unsubscribe ?? {}),
        [opts.unsub.senderKey]: opts.unsub.url,
      };
    }

    return trimToByteBudget(this._metadata, opts.maxBytes);
  }

  /**
   * Drop the given email keys from the index. Returns the removed entries so the
   * caller can purge their bodies/attachments.
   */
  removeEmails(keys: string[]): { removed: EmailMetadata[] } {
    const target = new Set(keys);
    const removed: EmailMetadata[] = [];
    const kept: EmailMetadata[] = [];
    for (const entry of this._metadata.emails) {
      (target.has(entry.key) ? removed : kept).push(entry);
    }
    this._metadata.emails = kept;
    return { removed };
  }
}
