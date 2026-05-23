import { Context } from "hono";

/** Calls ctx.waitUntil() without throwing when the ExecutionContext is absent (e.g. Node tests). */
export function waitUntilSafe(c: Context, promise: Promise<unknown>): void {
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // ExecutionContext unavailable in Node test environment — ignore.
  }
}
