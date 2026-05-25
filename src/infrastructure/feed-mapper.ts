import { FeedConfig, FeedListItem } from "../types";
import { FeedState } from "../domain/feed-state";
import { Feed } from "../domain/feed.aggregate";

/**
 * The translation seam between the Feed aggregate's domain state (camelCase) and
 * the persistence/edge DTOs (`FeedConfig`/`FeedListItem`, snake_case). This is
 * the ONLY place outside the HTTP edge that knows the stored field names — the
 * domain stays free of the storage dialect, and the repository round-trips
 * through here on every load/save.
 */

/** Persisted config DTO → domain state (used by `FeedRepository.load`). */
export function fromConfigDTO(dto: FeedConfig): FeedState {
  return {
    title: dto.title,
    description: dto.description,
    language: dto.language,
    mailboxId: dto.mailbox_id,
    author: dto.author,
    senderInTitle: dto.sender_in_title,
    allowedSenders: dto.allowed_senders ?? [],
    blockedSenders: dto.blocked_senders ?? [],
    createdAt: dto.created_at,
    updatedAt: dto.updated_at,
    expiresAt: dto.expires_at,
  };
}

/** Domain state → persisted config DTO (used by `FeedRepository.save`). */
export function toConfigDTO(state: FeedState): FeedConfig {
  return {
    title: state.title,
    description: state.description,
    language: state.language,
    mailbox_id: state.mailboxId,
    author: state.author,
    sender_in_title: state.senderInTitle,
    allowed_senders: state.allowedSenders,
    blocked_senders: state.blockedSenders,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    expires_at: state.expiresAt,
  };
}

/**
 * The Feed aggregate → the projection cached in the global `feeds:list` registry.
 * Unlike the config DTO, the list item is a read-model view: it folds in the
 * aggregate's metadata-derived signals (pending confirmation, native feed,
 * email count/last-received) alongside the config fields, so it reads the whole
 * aggregate through its intention-revealing accessors.
 */
export function toListItemDTO(feed: Feed): FeedListItem {
  return {
    id: feed.id.value,
    title: feed.title,
    description: feed.description,
    mailbox_id: feed.mailboxId.value,
    expires_at: feed.expiresAt,
    pendingConfirmation: feed.pendingConfirmation,
    hasNativeFeed: feed.hasNativeFeed(),
    emailCount: feed.emailCount,
    lastEmailAt: feed.lastEmailAt,
  };
}
