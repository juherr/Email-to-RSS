import { FeedId } from "./value-objects/feed-id";

/**
 * Domain events the Feed aggregate records when it mutates. They describe *what
 * happened* in business terms and carry their own `feedId`, so the application
 * dispatcher can route side effects (counters, WebSub pings, favicon caching)
 * without the caller threading the id back in. This keeps the aggregate ignorant
 * of infrastructure and the orchestration code free of scattered, inline effects.
 *
 * Only mutations that currently have side effects emit events — feed creation
 * and email ingestion. Edits and removals carry no side effect, so they emit
 * nothing. Side effects that don't flow through the aggregate (a rejected email,
 * a feed deletion that bypasses the aggregate, bulk admin operations) stay
 * outside this mechanism by design — they have no aggregate event to ride on.
 */
export type FeedEvent =
  | { type: "FeedCreated"; feedId: FeedId }
  | { type: "EmailIngested"; feedId: FeedId; iconDomain?: string };
