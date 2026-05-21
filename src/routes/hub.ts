import { Hono, type Context } from "hono";
import { Env } from "../types";
import {
  verifyAndStoreSubscription,
  verifyAndDeleteSubscription,
} from "../utils/websub";

function waitUntilSafe(c: Context, promise: Promise<unknown>) {
  // Hono throws when ExecutionContext isn't present (e.g. Node unit tests).
  try {
    c.executionCtx.waitUntil(promise);
  } catch {
    // ignore
  }
}

const DEFAULT_LEASE_SECONDS = 86400;
const MAX_LEASE_SECONDS = 30 * 24 * 3600; // 30 days

export const hubRouter = new Hono();

hubRouter.post("/", async (c) => {
  const env = c.env as unknown as Env;
  let form: FormData;
  try {
    form = await c.req.formData();
  } catch {
    return c.text(
      "Bad Request: expected application/x-www-form-urlencoded",
      400,
    );
  }

  const mode = form.get("hub.mode");
  const topic = form.get("hub.topic");
  const callbackUrl = form.get("hub.callback");

  if (!mode || !topic || !callbackUrl) {
    return c.text(
      "Bad Request: hub.mode, hub.topic and hub.callback are required",
      400,
    );
  }

  if (
    typeof mode !== "string" ||
    typeof topic !== "string" ||
    typeof callbackUrl !== "string"
  ) {
    return c.text("Bad Request: unexpected field types", 400);
  }

  if (mode !== "subscribe" && mode !== "unsubscribe") {
    return c.text(
      "Bad Request: hub.mode must be subscribe or unsubscribe",
      400,
    );
  }

  let parsedCallback: URL;
  try {
    parsedCallback = new URL(callbackUrl);
  } catch {
    return c.text("Bad Request: hub.callback must be a valid URL", 400);
  }
  if (parsedCallback.protocol !== "https:") {
    return c.text("Bad Request: hub.callback must use HTTPS", 400);
  }

  // Validate that topic matches a known RSS feed on this hub
  const topicPattern = new RegExp(
    `^https://${env.DOMAIN.replaceAll(".", "\\.")}/rss/([^/]+)$`,
  );
  const match = topic.match(topicPattern);
  if (!match) {
    return c.text(
      "Bad Request: hub.topic must be an RSS feed URL on this hub",
      400,
    );
  }
  const feedId = match[1];

  const secret = form.get("hub.secret") ?? undefined;
  if (secret && secret.length > 200) {
    return c.text("Bad Request: hub.secret must be under 200 bytes", 400);
  }
  const rawLease = parseInt(form.get("hub.lease_seconds") ?? "", 10);
  const leaseSeconds = isNaN(rawLease)
    ? DEFAULT_LEASE_SECONDS
    : Math.min(Math.max(rawLease, 1), MAX_LEASE_SECONDS);

  // Return 202 immediately; verification is async
  if (mode === "subscribe") {
    waitUntilSafe(
      c,
      verifyAndStoreSubscription(
        feedId,
        callbackUrl as string,
        secret as string | undefined,
        leaseSeconds,
        env,
      ),
    );
  } else {
    waitUntilSafe(
      c,
      verifyAndDeleteSubscription(feedId, callbackUrl as string, env),
    );
  }

  return c.text("Accepted", 202);
});
