/**
 * Domain events the Feed aggregate records when it mutates. They describe *what
 * happened* in business terms; the application layer decides which side effects
 * to run (counters, WebSub pings, favicon caching) via a dispatcher. This keeps
 * the aggregate ignorant of infrastructure and the orchestration code free of
 * scattered, inline side effects.
 *
 * Only mutations that currently have side effects emit events — feed creation
 * and email ingestion. Edits and removals carry no side effect, so they emit
 * nothing. Side effects that don't flow through the aggregate (a rejected email,
 * a feed deletion that bypasses the aggregate, bulk admin operations) stay
 * outside this mechanism by design — they have no aggregate event to ride on.
 */
export type FeedEvent =
  | { type: "FeedCreated" }
  | { type: "EmailIngested"; iconDomain?: string };
