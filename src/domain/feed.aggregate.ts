import { FeedConfig, FeedMetadata, EmailMetadata } from "../types";
import { FeedId } from "./value-objects/feed-id";
import { SenderPolicy, SenderDecision } from "./value-objects/sender-policy";
import { Clock, systemClock } from "./clock";
import { resolveExpiresAt, isExpired, trimToByteBudget } from "./feed";

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

/**
 * Dependencies the aggregate needs from the outside but must not reach for
 * itself: a clock (never ambient `Date.now()`) and an already-resolved feed
 * lifetime. The application layer decides the lifetime — parsing env config and
 * applying any server-side `FEED_TTL_HOURS` override — and hands the result in.
 */
export interface CreateFeedDeps {
  clock?: Clock;
  /** Effective lifetime in hours, already resolved by the application. */
  ttlHours?: number;
}

export interface EditFeedDeps {
  /** Effective lifetime in hours, already resolved by the application. */
  ttlHours?: number;
  /**
   * Whether to recompute expiry at all. False preserves the current expiry
   * (mirrors the old "no server TTL and no client lifetime ⇒ leave as-is").
   */
  recomputeExpiry?: boolean;
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
 * I/O-free and time-free: load and persist state through `FeedRepository`; time
 * comes from an injected `Clock`. KV has no multi-key transaction, so a future
 * Durable Object keyed by feed id would wrap load→mutate→save to serialise
 * concurrent writers (see email-processor.ts).
 */
export class Feed {
  private constructor(
    readonly id: FeedId,
    private _config: FeedConfig,
    private _metadata: FeedMetadata,
    private readonly clock: Clock,
  ) {}

  /** Mint a brand-new feed with an empty email index. */
  static create(
    id: FeedId,
    input: CreateFeedInput,
    deps: CreateFeedDeps = {},
  ): Feed {
    const clock = deps.clock ?? systemClock;
    const now = clock.now();
    const expiresAt = resolveExpiresAt(deps.ttlHours, now);
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
    return new Feed(id, config, { emails: [] }, clock);
  }

  /** Rebuild an aggregate from persisted state. */
  static reconstitute(
    id: FeedId,
    config: FeedConfig,
    metadata: FeedMetadata,
    clock: Clock = systemClock,
  ): Feed {
    return new Feed(id, config, metadata, clock);
  }

  get config(): Readonly<FeedConfig> {
    return this._config;
  }

  get metadata(): Readonly<FeedMetadata> {
    return this._metadata;
  }

  isExpired(now: number = this.clock.now()): boolean {
    return isExpired(this._config, now);
  }

  accepts(senders: string[]): SenderDecision {
    return SenderPolicy.fromLists(
      this._config.allowed_senders,
      this._config.blocked_senders,
    ).decide(senders);
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

  /**
   * In-place edit of the presentational fields only (title + description). Never
   * touches expiry or the sender policy — used by the dashboard's minimal edit.
   */
  editDetails(patch: { title?: string; description?: string }): void {
    if (patch.title !== undefined) this._config.title = patch.title;
    if (patch.description !== undefined) {
      this._config.description = patch.description;
    }
    this._config.updated_at = this.clock.now();
  }

  /**
   * Full edit: apply the patch and recompute expiry from the application-supplied
   * lifetime when asked (an absent recompute preserves the current expiry).
   * Rejects an already-expired feed without mutating it.
   */
  edit(
    patch: UpdateFeedInput,
    deps: EditFeedDeps = {},
  ): { status: "ok" | "expired" } {
    if (this.isExpired()) return { status: "expired" };

    const now = this.clock.now();
    const expiresAt = deps.recomputeExpiry
      ? resolveExpiresAt(deps.ttlHours, now)
      : this._config.expires_at;

    if (patch.title !== undefined) this._config.title = patch.title;
    if (patch.description !== undefined) {
      this._config.description = patch.description;
    }
    if (patch.language !== undefined) this._config.language = patch.language;
    if (patch.allowedSenders !== undefined) {
      this._config.allowed_senders = patch.allowedSenders;
    }
    if (patch.blockedSenders !== undefined) {
      this._config.blocked_senders = patch.blockedSenders;
    }
    this._config.updated_at = now;
    this._config.expires_at = expiresAt;

    return { status: "ok" };
  }
}
