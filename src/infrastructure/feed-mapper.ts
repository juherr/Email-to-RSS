import { FeedConfig, FeedListItem } from "../types";
import { FeedState } from "../domain/feed-state";
import { FeedId } from "../domain/value-objects/feed-id";

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
    allowed_senders: state.allowedSenders,
    blocked_senders: state.blockedSenders,
    created_at: state.createdAt,
    updated_at: state.updatedAt,
    expires_at: state.expiresAt,
  };
}

/** Domain state → the projection cached in the global `feeds:list` registry. */
export function toListItemDTO(
  id: FeedId,
  state: FeedState,
  pendingConfirmation = false,
): FeedListItem {
  return {
    id: id.value,
    title: state.title,
    description: state.description,
    mailbox_id: state.mailboxId,
    expires_at: state.expiresAt,
    ...(pendingConfirmation !== undefined ? { pendingConfirmation } : {}),
  };
}
