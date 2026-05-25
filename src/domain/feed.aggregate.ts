import { FeedMetadata, EmailMetadata } from "../types";
import { FeedState } from "./feed-state";
import { FeedId } from "./value-objects/feed-id";
import { MailboxId } from "./value-objects/mailbox-id";
import { Lifetime } from "./value-objects/lifetime";
import { SenderPolicy, SenderDecision } from "./value-objects/sender-policy";
import { Clock, systemClock } from "./clock";
import { FeedEvent } from "./events";

export interface CreateFeedInput {
  title: string;
  description?: string;
  language: string;
  allowedSenders: string[];
  blockedSenders: string[];
  /** When true, render entry titles as `[Sender] Subject` in the feed output. */
  senderInTitle?: boolean;
  /** Raw client-requested lifetime; the application resolves it into a `Lifetime`. */
  lifetimeHours?: number;
}

export interface UpdateFeedInput {
  title?: string;
  description?: string;
  language?: string;
  allowedSenders?: string[];
  blockedSenders?: string[];
  senderInTitle?: boolean;
  lifetimeHours?: number;
}

/**
 * Dependencies the aggregate needs from the outside but must not reach for
 * itself: a clock (never ambient `Date.now()`) and an already-resolved
 * `Lifetime`. The application layer decides the lifetime — parsing env config and
 * applying any server-side `FEED_TTL_HOURS` override — and hands the VO in.
 */
export interface CreateFeedDeps {
  /** The feed's inbound mailbox, minted by the application alongside its FeedId. */
  mailboxId: MailboxId;
  clock?: Clock;
  /** Effective lifetime, already resolved by the application. */
  lifetime?: Lifetime;
}

export interface EditFeedDeps {
  /**
   * Effective lifetime, already resolved by the application. Its *presence* means
   * "recompute expiry"; its absence preserves the current expiry — which covers
   * the dashboard's title/description quick-edit.
   */
  lifetime?: Lifetime;
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
 * Its config is held as domain `FeedState` (camelCase), never the snake_case
 * persistence DTO — `FeedRepository` translates via `feed-mapper.ts`. I/O-free
 * and time-free: load and persist through the repository; time comes from an
 * injected `Clock`. KV has no multi-key transaction, so a future Durable Object
 * keyed by feed id would wrap load→mutate→save to serialise concurrent writers
 * (see email-processor.ts).
 */
export class Feed {
  private readonly _events: FeedEvent[] = [];

  private constructor(
    readonly id: FeedId,
    private _state: FeedState,
    private _metadata: FeedMetadata,
    private readonly clock: Clock,
  ) {}

  /** Mint a brand-new feed with an empty email index. */
  static create(
    id: FeedId,
    input: CreateFeedInput,
    deps: CreateFeedDeps,
  ): Feed {
    const clock = deps.clock ?? systemClock;
    const now = clock.now();
    const expiresAt = (deps.lifetime ?? Lifetime.never).resolveExpiry(now);
    const state: FeedState = {
      title: input.title,
      description: input.description,
      language: input.language,
      mailboxId: deps.mailboxId.value,
      senderInTitle: input.senderInTitle,
      allowedSenders: input.allowedSenders,
      blockedSenders: input.blockedSenders,
      createdAt: now,
      updatedAt: now,
      expiresAt,
    };
    const feed = new Feed(id, state, { emails: [] }, clock);
    feed._events.push({ type: "FeedCreated", feedId: id });
    return feed;
  }

  /** Rebuild an aggregate from persisted (already-mapped) domain state. */
  static reconstitute(
    id: FeedId,
    state: FeedState,
    metadata: FeedMetadata,
    clock: Clock = systemClock,
  ): Feed {
    return new Feed(id, state, metadata, clock);
  }

  // ── Intention-revealing reads ─────────────────────────────────────────────
  // The aggregate exposes named fields and copies of its collections, never the
  // raw `state`/`metadata` objects — a shallow `Readonly<…>` would still let a
  // caller mutate the arrays inside. Persistence reads `state()` /
  // `toMetadataSnapshot()`; the mapper derives the DTOs.

  get title(): string {
    return this._state.title;
  }

  get description(): string | undefined {
    return this._state.description;
  }

  get language(): string {
    return this._state.language;
  }

  /** The inbound mailbox (`noun.noun.NN`) — the feed's email address is `mailboxId@domain`. */
  get mailboxId(): MailboxId {
    return MailboxId.unchecked(this._state.mailboxId);
  }

  get createdAt(): number {
    return this._state.createdAt;
  }

  get updatedAt(): number | undefined {
    return this._state.updatedAt;
  }

  get expiresAt(): number | undefined {
    return this._state.expiresAt;
  }

  get iconDomain(): string | undefined {
    return this._metadata.iconDomain;
  }

  /** True while at least one unactioned confirmation email is present. */
  get pendingConfirmation(): boolean {
    return this._metadata.pendingConfirmation ?? false;
  }

  allowedSenders(): string[] {
    return [...this._state.allowedSenders];
  }

  blockedSenders(): string[] {
    return [...this._state.blockedSenders];
  }

  /** A copy of the email index — mutating it never touches aggregate state. */
  get emails(): readonly EmailMetadata[] {
    return [...this._metadata.emails];
  }

  /** Per-sender one-click unsubscribe links (copy). */
  unsubscribeUrls(): Record<string, string> {
    return { ...(this._metadata.unsubscribe ?? {}) };
  }

  // ── Persistence snapshots (repository-only) ───────────────────────────────

  /** A copy of the domain config state for the repository to map + persist. */
  state(): FeedState {
    return {
      ...this._state,
      allowedSenders: [...this._state.allowedSenders],
      blockedSenders: [...this._state.blockedSenders],
    };
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
    // The shared `isExpired` predicate (domain/feed.ts) lives on the read path
    // and speaks the persistence DTO; the aggregate checks its own domain state.
    return this._state.expiresAt !== undefined && this._state.expiresAt <= now;
  }

  accepts(senders: string[]): SenderDecision {
    return SenderPolicy.fromLists(
      this._state.allowedSenders,
      this._state.blockedSenders,
    ).decide(senders);
  }

  /**
   * Check whether the email index already contains a duplicate of the incoming
   * email. Dedup uses `messageId` as the primary key (when both sides have one)
   * and falls back to `dedupHash` (SHA-256 of normalised subject+content).
   * Old entries that predate the feature and carry neither field are never
   * matched — they cannot cause false positives.
   */
  hasDuplicate(messageId?: string, dedupHash?: string): boolean {
    for (const entry of this._metadata.emails) {
      if (messageId && entry.messageId && entry.messageId === messageId) {
        return true;
      }
      if (
        !messageId &&
        dedupHash &&
        entry.dedupHash &&
        entry.dedupHash === dedupHash
      ) {
        return true;
      }
    }
    return false;
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

    if (entry.confirmation) {
      this._metadata.pendingConfirmation = true;
    }

    this._events.push({
      type: "EmailIngested",
      feedId: this.id,
      iconDomain: opts.iconDomain,
    });
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
    // Lower-only: clear when no confirmation email remains. Never re-raise here,
    // so an admin "dismiss" survives deletion of unrelated emails.
    if (!kept.some((e) => e.confirmation)) {
      this._metadata.pendingConfirmation = false;
    }
    return { removed };
  }

  /** Mark the pending confirmation as handled — "stop reminding me". */
  dismissConfirmation(): void {
    this._metadata.pendingConfirmation = false;
  }

  /**
   * The single edit path. Apply the patch (only the fields it carries) and
   * recompute expiry when the application supplies a `Lifetime` — an absent
   * lifetime preserves the current expiry, which covers the dashboard's
   * title/description quick-edit. Rejects an already-expired feed without
   * mutating it, so a quick-edit can no more touch an expired feed than a full
   * edit can.
   */
  edit(
    patch: UpdateFeedInput,
    deps: EditFeedDeps = {},
  ): { status: "ok" | "expired" } {
    if (this.isExpired()) return { status: "expired" };

    const now = this.clock.now();
    const expiresAt = deps.lifetime
      ? deps.lifetime.resolveExpiry(now)
      : this._state.expiresAt;

    if (patch.title !== undefined) this._state.title = patch.title;
    if (patch.description !== undefined) {
      this._state.description = patch.description;
    }
    if (patch.language !== undefined) this._state.language = patch.language;
    if (patch.senderInTitle !== undefined) {
      this._state.senderInTitle = patch.senderInTitle;
    }
    if (patch.allowedSenders !== undefined) {
      this._state.allowedSenders = patch.allowedSenders;
    }
    if (patch.blockedSenders !== undefined) {
      this._state.blockedSenders = patch.blockedSenders;
    }
    this._state.updatedAt = now;
    this._state.expiresAt = expiresAt;

    return { status: "ok" };
  }
}
