/**
 * The Feed aggregate's internal config state, in domain (camelCase) vocabulary.
 * This is deliberately NOT the persistence shape: the snake_case `FeedConfig`
 * DTO is an infrastructure concern, and the translation between the two lives in
 * `infrastructure/feed-mapper.ts`. The domain never speaks the storage dialect.
 *
 * `expiresAt` is an absolute instant (epoch ms) already resolved from a
 * `Lifetime`; the aggregate stores the resolved value, not the policy.
 */
export interface FeedState {
  title: string;
  description?: string;
  language: string;
  /** The feed's inbound mailbox local part (`noun.noun.NN`) — its email address
   * is `mailboxId@domain`. Decoupled from the feed's `FeedId` (the read id). */
  mailboxId: string;
  author?: string;
  allowedSenders: string[];
  blockedSenders: string[];
  createdAt: number;
  updatedAt?: number;
  expiresAt?: number;
}
