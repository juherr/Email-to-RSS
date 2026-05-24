import { Env } from "../types";
import { FeedEvent } from "../domain/events";
import { Feed } from "../domain/feed.aggregate";
import { BackgroundScheduler } from "../infrastructure/worker";
import { bumpCounters } from "./stats";
import { notifySubscribers } from "../infrastructure/websub";
import { cacheFaviconForDomain } from "../infrastructure/favicon-fetcher";

/**
 * Apply the side effects of a feed's domain events — the single place that maps
 * "what happened" (FeedCreated, EmailIngested) to its consequences. Each event
 * carries its own `feedId`, so nothing has to be threaded in. Counter writes are
 * awaited (they must land); WebSub pings and favicon fetches are handed to the
 * caller's background scheduler (`ctx.waitUntil` at the edge, a no-op when none
 * is available).
 */
export async function applyFeedEvents(
  events: FeedEvent[],
  env: Env,
  schedule: BackgroundScheduler,
): Promise<void> {
  for (const event of events) {
    switch (event.type) {
      case "FeedCreated":
        await bumpCounters(env.EMAIL_STORAGE, {
          feeds_created: 1,
          last_feed_created_at: new Date().toISOString(),
        });
        break;
      case "EmailIngested":
        await bumpCounters(env.EMAIL_STORAGE, {
          emails_received: 1,
          last_email_at: new Date().toISOString(),
        });
        schedule(notifySubscribers(event.feedId, env));
        if (event.iconDomain) {
          schedule(cacheFaviconForDomain(event.iconDomain, env));
        }
        break;
    }
  }
}

/**
 * Drain a freshly-persisted aggregate's events and apply their side effects. The
 * single dispatch entry point: callers persist the `Feed`, then call this — no
 * caller pulls events or passes the feed id by hand.
 */
export async function dispatchFeedEvents(
  feed: Feed,
  env: Env,
  schedule: BackgroundScheduler,
): Promise<void> {
  await applyFeedEvents(feed.pullEvents(), env, schedule);
}
