import {
  FeedConfig,
  FeedMetadata,
  EmailMetadata,
  FeedListItem,
} from "../types";
import { FeedId } from "./value-objects/feed-id";
import { SenderPolicy, SenderDecision } from "./value-objects/sender-policy";
import { Clock, systemClock } from "./clock";
import { FeedEvent } from "./events";
import { isExpired } from "./feed";

const HOUR_MS = 3_600_000;

/**
 * Resolve a feed's `expires_at` from an already-resolved lifetime (hours) and a
 * current instant. Returns undefined when no positive lifetime applies (the feed
 * never expires). Which lifetime applies (client request vs. server-side
 * override, env parsing) is the application layer's call — the aggregate only
 * receives the resolved number. File-private: the aggregate is its sole user.
 */
function resolveExpiresAt(
  ttlHours: number | undefined,
  now: number,
): number | undefined {
  return ttlHours !== undefined && Number.isFinite(ttlHours) && ttlHours > 0
    ? now + ttlHours * HOUR_MS
    : undefined;
}

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
  private readonly _events: FeedEvent[] = [];

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
    const feed = new Feed(id, config, { emails: [] }, clock);
    feed._events.push({ type: "FeedCreated" });
    return feed;
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

  // ── Intention-revealing reads ─────────────────────────────────────────────
  // The aggregate exposes named fields and copies of its collections, never the
  // raw `config`/`metadata` objects — a shallow `Readonly<…>` would still let a
  // caller mutate the arrays inside. Persistence reads `toConfigSnapshot()` /
  // `toMetadataSnapshot()`; the registry reads `summary()`.

  get title(): string {
    return this._config.title;
  }

  get description(): string | undefined {
    return this._config.description;
  }

  get language(): string {
    return this._config.language;
  }

  get createdAt(): number {
    return this._config.created_at;
  }

  get updatedAt(): number | undefined {
    return this._config.updated_at;
  }

  get expiresAt(): number | undefined {
    return this._config.expires_at;
  }

  get iconDomain(): string | undefined {
    return this._metadata.iconDomain;
  }

  allowedSenders(): string[] {
    return [...(this._config.allowed_senders ?? [])];
  }

  blockedSenders(): string[] {
    return [...(this._config.blocked_senders ?? [])];
  }

  /** A copy of the email index — mutating it never touches aggregate state. */
  get emails(): readonly EmailMetadata[] {
    return [...this._metadata.emails];
  }

  /** Per-sender one-click unsubscribe links (copy). */
  unsubscribeUrls(): Record<string, string> {
    return { ...(this._metadata.unsubscribe ?? {}) };
  }

  /** The projection stored in the global `feeds:list` registry. */
  summary(): FeedListItem {
    return {
      id: this.id.value,
      title: this._config.title,
      description: this._config.description,
      expires_at: this._config.expires_at,
    };
  }

  // ── Persistence snapshots (repository-only) ───────────────────────────────

  /** A serialisable copy of the config for the repository to persist. */
  toConfigSnapshot(): FeedConfig {
    return { ...this._config };
  }

  /** A serialisable copy of the email index for the repository to persist. */
  toMetadataSnapshot(): FeedMetadata {
    return { ...this._metadata, emails: [...this._metadata.emails] };
  }

  /**
   * Drain the domain events recorded since the last pull. The application layer
   * calls this after persisting and feeds them to a dispatcher that runs the
   * side effects (counters, WebSub, favicon). Clearing on read keeps a long-lived
   * aggregate from re-emitting.
   */
  pullEvents(): FeedEvent[] {
    return this._events.splice(0, this._events.length);
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

    this._events.push({ type: "EmailIngested", iconDomain: opts.iconDomain });
    return this.trimToByteBudget(opts.maxBytes);
  }

  /**
   * Enforce the per-feed byte budget by dropping the oldest emails (from the
   * tail of the index) until the total fits, always keeping at least one entry.
   * Returns the dropped entries so the caller can purge their KV/R2 storage.
   */
  private trimToByteBudget(maxBytes: number): { dropped: EmailMetadata[] } {
    const emails = this._metadata.emails;
    let totalSize = emails.reduce((sum, e) => sum + (e.size ?? 0), 0);
    const dropped: EmailMetadata[] = [];
    while (totalSize > maxBytes && emails.length > 1) {
      const entry = emails.pop()!;
      totalSize -= entry.size ?? 0;
      dropped.push(entry);
    }
    return { dropped };
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
   * The single edit path. Apply the patch (only the fields it carries) and
   * recompute expiry from the application-supplied lifetime when asked — an
   * absent recompute preserves the current expiry, which covers the dashboard's
   * title/description quick-edit (`recomputeExpiry: false`). Rejects an
   * already-expired feed without mutating it, so a quick-edit can no more touch
   * an expired feed than a full edit can.
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
