import { Context } from "hono";

/**
 * Schedules a fire-and-forget background task. The HTTP edge adapts this over
 * `ctx.waitUntil`; the application/domain layers depend on this plain function
 * type instead of Hono's `Context`.
 */
export type BackgroundScheduler = (task: Promise<unknown>) => void;

/** Calls ctx.waitUntil() without throwing when the ExecutionContext is absent (e.g. Node tests). */
export function waitUntilSafe(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // ExecutionContext unavailable in Node test environment — ignore.
  }
}
