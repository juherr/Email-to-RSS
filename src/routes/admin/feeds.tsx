import { Hono } from "hono";
import { z } from "zod";
import { Env, FeedConfig, FeedMetadata } from "../../types";
import { generateFeedId } from "../../utils/id-generator";
import { bumpCounters } from "../../utils/stats";
import { waitUntilSafe } from "../../utils/worker";
import { feedRssUrl, feedEmailAddress } from "../../utils/urls";
import { logger } from "../../lib/logger";
import { Layout } from "./ui";
import {
  addFeedToList,
  updateFeedInList,
  removeFeedFromList,
  removeFeedsFromListBulk,
  deleteKeysWithConcurrency,
  purgeFeedKeysStep,
} from "./helpers";

type AppEnv = { Bindings: Env };

export const feedsRouter = new Hono<AppEnv>();

function normalizeAllowedSenders(senders: string[]): string[] {
  return senders.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function parseAllowedSenders(rawAllowedSenders: string): string[] {
  return normalizeAllowedSenders(rawAllowedSenders.split(/[\n,]+/));
}

const createFeedSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  language: z.string().optional().default("en"),
  allowedSenders: z.array(z.string()).optional().default([]),
  blockedSenders: z.array(z.string()).optional().default([]),
});

const updateFeedSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  language: z.string().optional().default("en"),
  allowedSenders: z.array(z.string()).optional().default([]),
  blockedSenders: z.array(z.string()).optional().default([]),
});

const senderFilterSchema = z.object({
  action: z.enum(["allow_sender", "allow_domain", "block_sender", "block_domain"]),
  value: z.string().min(1),
});

// ── Delete helpers ────────────────────────────────────────────────────────────

type DeleteFeedFastResult = {
  ok: boolean;
  configDeleted: boolean;
  metadataDeleted: boolean;
  errors: string[];
};

async function deleteFeedFastDetailed(
  emailStorage: KVNamespace,
  feedId: string,
): Promise<DeleteFeedFastResult> {
  const feedConfigKey = `feed:${feedId}:config`;
  const feedMetadataKey = `feed:${feedId}:metadata`;

  const errors: string[] = [];
  let configDeleted = false;
  let metadataDeleted = false;

  try {
    await emailStorage.delete(feedConfigKey);
    configDeleted = true;
  } catch (error) {
    errors.push(`config delete failed: ${String(error)}`);
  }

  try {
    await emailStorage.delete(feedMetadataKey);
    metadataDeleted = true;
  } catch (error) {
    errors.push(`metadata delete failed: ${String(error)}`);
  }

  return { ok: configDeleted, configDeleted, metadataDeleted, errors };
}

async function deleteFeedFast(
  emailStorage: KVNamespace,
  feedId: string,
): Promise<boolean> {
  const result = await deleteFeedFastDetailed(emailStorage, feedId);
  return result.ok;
}

// ── Routes ────────────────────────────────────────────────────────────────────

feedsRouter.post("/create", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const isJson =
    c.req.header("Content-Type")?.includes("application/json") ?? false;

  try {
    let title: string;
    let description: string | undefined;
    let language: string;
    let view: string;
    let allowedSenders: string[];
    let blockedSenders: string[];
    let lifetimeHoursRaw: string | undefined;

    if (isJson) {
      const body = await c.req.json<Record<string, unknown>>();
      title = String(body.title ?? "");
      description =
        body.description != null ? String(body.description) : undefined;
      language = String(body.language ?? "en");
      view = "list";
      allowedSenders = Array.isArray(body.allowedSenders)
        ? normalizeAllowedSenders(
            (body.allowedSenders as unknown[]).map(String),
          )
        : [];
      blockedSenders = Array.isArray(body.blockedSenders)
        ? normalizeAllowedSenders(
            (body.blockedSenders as unknown[]).map(String),
          )
        : [];
      lifetimeHoursRaw =
        body.lifetimeHours != null ? String(body.lifetimeHours) : undefined;
    } else {
      const formData = await c.req.formData();
      title = formData.get("title")?.toString() || "";
      description = formData.get("description")?.toString();
      language = formData.get("language")?.toString() || "en";
      view = formData.get("view")?.toString() === "table" ? "table" : "list";
      allowedSenders = parseAllowedSenders(
        formData.get("allowed_senders")?.toString() || "",
      );
      blockedSenders = parseAllowedSenders(
        formData.get("blocked_senders")?.toString() || "",
      );
      lifetimeHoursRaw = formData.get("lifetime_hours")?.toString();
    }

    const parsedData = createFeedSchema.parse({
      title,
      description,
      language,
      allowedSenders,
      blockedSenders,
    });

    // FEED_TTL_HOURS overrides any client-submitted value
    const resolvedHours = env.FEED_TTL_HOURS
      ? parseInt(env.FEED_TTL_HOURS, 10)
      : lifetimeHoursRaw
        ? parseInt(lifetimeHoursRaw, 10)
        : NaN;
    const expiresAt =
      Number.isFinite(resolvedHours) && resolvedHours > 0
        ? Date.now() + resolvedHours * 3_600_000
        : undefined;

    const feedId = generateFeedId();

    const feedConfig: FeedConfig = {
      title: parsedData.title,
      description: parsedData.description,
      language: parsedData.language,
      allowed_senders: parsedData.allowedSenders,
      blocked_senders: parsedData.blockedSenders,
      created_at: Date.now(),
      updated_at: Date.now(),
      ...(expiresAt !== undefined ? { expires_at: expiresAt } : {}),
    };

    const feedMetadata: FeedMetadata = { emails: [] };

    await Promise.all([
      emailStorage.put(`feed:${feedId}:config`, JSON.stringify(feedConfig)),
      emailStorage.put(`feed:${feedId}:metadata`, JSON.stringify(feedMetadata)),
    ]);

    await addFeedToList(
      emailStorage,
      feedId,
      parsedData.title,
      parsedData.description,
      expiresAt,
    );

    await bumpCounters(emailStorage, {
      feeds_created: 1,
      last_feed_created_at: new Date().toISOString(),
    });

    if (isJson) {
      return c.json({
        feedId,
        email: feedEmailAddress(feedId, env),
        feedUrl: feedRssUrl(feedId, env),
      });
    }

    return c.redirect(`/admin?view=${view}`);
  } catch (error) {
    logger.error("Error creating feed", { error: String(error) });
    if (c.req.header("Content-Type")?.includes("application/json")) {
      return c.json({ error: "Error creating feed." }, 400);
    }
    return c.text("Error creating feed. Please try again.", 400);
  }
});

feedsRouter.get("/:feedId/edit", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");

  const feedConfig = (await emailStorage.get(`feed:${feedId}:config`, {
    type: "json",
  })) as FeedConfig | null;

  if (!feedConfig) {
    return c.text("Feed not found", 404);
  }

  const now = Date.now();
  const isExpired =
    feedConfig.expires_at !== undefined && feedConfig.expires_at <= now;
  const ttlLocked = !!env.FEED_TTL_HOURS;

  // Remaining hours: ceil so we don't show 0 when there's still time left
  const remainingHours =
    feedConfig.expires_at !== undefined && feedConfig.expires_at > now
      ? Math.ceil((feedConfig.expires_at - now) / 3_600_000)
      : undefined;

  const lifetimeFieldValue =
    ttlLocked && !isExpired
      ? (env.FEED_TTL_HOURS ?? "")
      : (remainingHours?.toString() ?? "");

  return c.html(
    <Layout title="Edit Feed">
      <div class="container fade-in">
        <div class="header-with-actions">
          <div class="header-title">
            <h1>{feedConfig.title} - Edit Feed</h1>
          </div>
          <div class="header-actions">
            <a href="/admin" class="button button-secondary button-back">
              Back to Dashboard
            </a>
          </div>
        </div>

        {isExpired && (
          <div class="card card-warning">
            <p>
              <strong>This feed has expired.</strong> It no longer accepts
              emails and its content is no longer publicly accessible.
            </p>
            <form
              action={`/admin/feeds/${feedId}/delete`}
              method="post"
              style="margin-top: 0.75rem;"
            >
              <button type="submit" class="button button-danger">
                Delete this feed
              </button>
            </form>
          </div>
        )}

        <div class={`card${isExpired ? " card-disabled" : ""}`}>
          <form action={`/admin/feeds/${feedId}/edit`} method="post">
            <div class="form-group">
              <label for="title">Feed Title</label>
              <input
                type="text"
                id="title"
                name="title"
                value={feedConfig.title}
                required
                disabled={isExpired}
              />
            </div>

            <div class="form-group">
              <label for="description">Description</label>
              <textarea
                id="description"
                name="description"
                rows={3}
                disabled={isExpired}
              >
                {feedConfig.description || ""}
              </textarea>
            </div>

            <div class="form-group">
              <label for="allowed_senders">
                Allowed senders (optional, one email or domain per line)
              </label>
              <textarea
                id="allowed_senders"
                name="allowed_senders"
                rows={3}
                placeholder={"newsletter@example.com\ntechmeme.com"}
                disabled={isExpired}
              >
                {(feedConfig.allowed_senders || []).join("\n")}
              </textarea>
              <small>
                When set, inbound emails are only accepted from these
                senders/domains.
              </small>
            </div>

            <div class="form-group">
              <label for="blocked_senders">
                Blocked senders (optional, one email or domain per line)
              </label>
              <textarea
                id="blocked_senders"
                name="blocked_senders"
                rows={3}
                placeholder={"spam@example.com\nunwanted.com"}
                disabled={isExpired}
              >
                {(feedConfig.blocked_senders || []).join("\n")}
              </textarea>
              <small>
                Emails from these senders/domains are always rejected, even if
                they match the allowlist.
              </small>
            </div>

            <div class="form-group">
              <label for="lifetime_hours">Lifetime (hours)</label>
              <input
                type="number"
                id="lifetime_hours"
                name="lifetime_hours"
                min="1"
                value={lifetimeFieldValue}
                disabled={isExpired || ttlLocked}
                placeholder={feedConfig.expires_at ? undefined : "No expiry"}
              />
              {ttlLocked ? (
                <small>
                  Feed lifetime is fixed to {env.FEED_TTL_HOURS}h by server
                  configuration.
                </small>
              ) : (
                <small>
                  Hours from now until this feed expires. Leave empty to keep
                  the current expiry (or no expiry).
                </small>
              )}
            </div>

            <input type="hidden" id="language" name="language" value="en" />

            {!isExpired && (
              <button type="submit" class="button">
                Update Feed
              </button>
            )}
          </form>
        </div>
      </div>
    </Layout>,
  );
});

feedsRouter.post("/:feedId/edit", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");

  try {
    const formData = await c.req.formData();
    const title = formData.get("title")?.toString() || "";
    const description = formData.get("description")?.toString();
    const language = formData.get("language")?.toString() || "en";
    const allowedSenders = parseAllowedSenders(
      formData.get("allowed_senders")?.toString() || "",
    );
    const blockedSenders = parseAllowedSenders(
      formData.get("blocked_senders")?.toString() || "",
    );
    const lifetimeHoursRaw = formData.get("lifetime_hours")?.toString();

    const parsedData = updateFeedSchema.parse({
      title,
      description,
      language,
      allowedSenders,
      blockedSenders,
    });

    const feedConfigKey = `feed:${feedId}:config`;
    const existingConfig = (await emailStorage.get(feedConfigKey, {
      type: "json",
    })) as FeedConfig | null;

    if (!existingConfig) {
      return c.text("Feed not found", 404);
    }

    // Expired feeds cannot be edited
    if (
      existingConfig.expires_at !== undefined &&
      existingConfig.expires_at <= Date.now()
    ) {
      return c.text("Feed has expired and cannot be modified.", 403);
    }

    // Resolve new expires_at:
    // - FEED_TTL_HOURS set: always recompute from env (reset TTL from now)
    // - Field submitted: set new expiry from now
    // - Field empty: preserve existing expires_at (no silent removal)
    let newExpiresAt: number | undefined;
    if (env.FEED_TTL_HOURS) {
      const h = parseInt(env.FEED_TTL_HOURS, 10);
      newExpiresAt =
        Number.isFinite(h) && h > 0 ? Date.now() + h * 3_600_000 : undefined;
    } else if (lifetimeHoursRaw) {
      const h = parseInt(lifetimeHoursRaw, 10);
      newExpiresAt =
        Number.isFinite(h) && h > 0 ? Date.now() + h * 3_600_000 : undefined;
    } else {
      newExpiresAt = existingConfig.expires_at;
    }

    const updatedConfig: FeedConfig = {
      ...existingConfig,
      title: parsedData.title,
      description: parsedData.description,
      language: parsedData.language,
      allowed_senders: parsedData.allowedSenders,
      blocked_senders: parsedData.blockedSenders,
      updated_at: Date.now(),
      expires_at: newExpiresAt,
    };

    await emailStorage.put(feedConfigKey, JSON.stringify(updatedConfig));

    await updateFeedInList(
      emailStorage,
      feedId,
      parsedData.title,
      parsedData.description,
      newExpiresAt,
    );

    return c.redirect("/admin");
  } catch (error) {
    logger.error("Error updating feed", { feedId, error: String(error) });
    return c.text("Error updating feed. Please try again.", 400);
  }
});

// ── Sender filter quick-add ───────────────────────────────────────────────────

feedsRouter.post("/:feedId/sender-filter", async (c) => {
  const env = c.env;
  const feedId = c.req.param("feedId");
  const feedConfigKey = `feed:${feedId}:config`;

  const body = await c.req.json().catch(() => null);
  const parsed = senderFilterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: "Invalid request" }, 400);
  }

  const { action, value } = parsed.data;
  const normalized = value.trim().toLowerCase();

  const feedConfig = (await env.EMAIL_STORAGE.get(feedConfigKey, {
    type: "json",
  })) as FeedConfig | null;
  if (!feedConfig) return c.json({ ok: false, error: "Feed not found" }, 404);

  const allowedSenders = (feedConfig.allowed_senders || []).map((s) =>
    s.trim().toLowerCase(),
  );
  const blockedSenders = (feedConfig.blocked_senders || []).map((s) =>
    s.trim().toLowerCase(),
  );

  const isAllowAction = action === "allow_sender" || action === "allow_domain";
  const targetList = isAllowAction ? allowedSenders : blockedSenders;
  const oppositeList = isAllowAction ? blockedSenders : allowedSenders;
  const oppositeLabel = isAllowAction ? "blocklist" : "allowlist";

  if (oppositeList.includes(normalized)) {
    return c.json(
      {
        ok: false,
        error: `"${normalized}" is already in the ${oppositeLabel}`,
      },
      409,
    );
  }

  if (!targetList.includes(normalized)) {
    targetList.push(normalized);
    await env.EMAIL_STORAGE.put(
      feedConfigKey,
      JSON.stringify({
        ...feedConfig,
        allowed_senders: allowedSenders,
        blocked_senders: blockedSenders,
        updated_at: Date.now(),
      }),
    );
  }

  return c.json({ ok: true });
});

feedsRouter.post("/:feedId/delete", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");
  const view = c.req.query("view") === "table" ? "table" : "list";
  const wantsJson = (c.req.header("Accept") || "").includes("application/json");

  try {
    await deleteFeedFast(emailStorage, feedId);
    const removed = await removeFeedFromList(emailStorage, feedId);
    if (removed) {
      await bumpCounters(emailStorage, { feeds_deleted: 1 });
    }

    waitUntilSafe(
      c,
      purgeFeedKeysStep(emailStorage, feedId, {
        bucket: env.ATTACHMENT_BUCKET,
      }),
    );

    if (wantsJson) {
      return c.json({ ok: true, feedId });
    }
    return c.redirect(`/admin?view=${view}`);
  } catch (error) {
    logger.error("Error deleting feed", { feedId, error: String(error) });
    if (wantsJson) {
      return c.json(
        { ok: false, error: "Error deleting feed. Please try again." },
        400,
      );
    }
    return c.text("Error deleting feed. Please try again.", 400);
  }
});

feedsRouter.post("/:feedId/purge", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");

  try {
    const body = (await c.req.json().catch(() => null)) as {
      cursor?: unknown;
      limit?: unknown;
    } | null;

    const cursor = body?.cursor ? String(body.cursor) : undefined;
    const limit = Number.isFinite(Number(body?.limit))
      ? Number(body?.limit)
      : 100;

    const step = await purgeFeedKeysStep(emailStorage, feedId, {
      cursor,
      limit,
      bucket: env.ATTACHMENT_BUCKET,
    });

    return c.json({
      ok: step.failedKeys.length === 0,
      deletedCount: step.deletedKeys.length,
      failedCount: step.failedKeys.length,
      cursor: step.cursor,
      listComplete: step.listComplete,
    });
  } catch (error) {
    logger.error("Error purging feed keys", { feedId, error: String(error) });
    return c.json({ ok: false, error: "Error purging feed keys" }, 500);
  }
});

feedsRouter.post("/bulk-delete", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const contentType = c.req.header("Content-Type") || "";
  const wantsJson =
    contentType.includes("application/json") ||
    (c.req.header("Accept") || "").includes("application/json");

  try {
    if (wantsJson) {
      const body = (await c.req.json().catch(() => null)) as {
        feedIds?: unknown;
      } | null;

      const rawIds = Array.isArray(body?.feedIds) ? body?.feedIds : [];
      const parsedFeedIds = Array.from(
        new Set(rawIds.map((value) => String(value)).filter(Boolean)),
      );

      if (parsedFeedIds.length === 0) {
        return c.json({ ok: false, error: "No feeds were selected." }, 400);
      }

      if (parsedFeedIds.length > 50) {
        return c.json(
          {
            ok: false,
            error:
              "Too many feedIds for a single request. Please delete in smaller batches.",
          },
          413,
        );
      }

      const okIds: string[] = [];
      const failures: Array<{ feedId: string; error: string }> = [];
      const warnings: Array<{ feedId: string; warning: string }> = [];

      for (const feedId of parsedFeedIds) {
        try {
          const result = await deleteFeedFastDetailed(emailStorage, feedId);
          if (!result.ok) {
            failures.push({
              feedId,
              error:
                result.errors.join("; ") ||
                "Failed to delete feed config (feed may still be active).",
            });
            continue;
          }

          if (!result.metadataDeleted) {
            warnings.push({
              feedId,
              warning:
                "Feed config deleted, but metadata cleanup failed. This is usually safe, but storage cleanup may be incomplete.",
            });
          }

          okIds.push(feedId);
        } catch (error) {
          logger.error("Error bulk deleting feed", {
            feedId,
            error: String(error),
          });
          failures.push({ feedId, error: String(error) });
        }
      }

      const deletedFeedIds = await removeFeedsFromListBulk(emailStorage, okIds);
      if (deletedFeedIds.length > 0) {
        await bumpCounters(emailStorage, { feeds_deleted: deletedFeedIds.length });
      }

      const removed = new Set(deletedFeedIds);
      okIds.forEach((feedId) => {
        if (!removed.has(feedId)) {
          failures.push({
            feedId,
            error:
              "Feed config deleted, but failed to remove it from feeds:list. Refresh and try again.",
          });
        }
      });

      const failedFeedIds = Array.from(new Set(failures.map((f) => f.feedId)));

      return c.json({
        ok: failedFeedIds.length === 0,
        deletedFeedIds,
        failedFeedIds,
        failures,
        warnings,
      });
    }

    const formData = await c.req.formData();
    const view =
      formData.get("view")?.toString() === "table" ? "table" : "list";
    const redirectBase = `/admin?view=${view}`;
    const rawIds = formData.getAll("feedIds").map((value) => value.toString());
    const parsedFeedIds = Array.from(new Set(rawIds.filter(Boolean)));

    if (parsedFeedIds.length === 0) {
      return c.redirect(`${redirectBase}&message=bulkDeleteNoop`);
    }

    const okIds: string[] = [];

    for (const feedId of parsedFeedIds) {
      try {
        const result = await deleteFeedFastDetailed(emailStorage, feedId);
        if (result.ok) okIds.push(feedId);
      } catch (error) {
        logger.error("Error bulk deleting feed", {
          feedId,
          error: String(error),
        });
      }
    }

    const deletedFeedIds = await removeFeedsFromListBulk(emailStorage, okIds);
    if (deletedFeedIds.length > 0) {
      await bumpCounters(emailStorage, { feeds_deleted: deletedFeedIds.length });
    }

    return c.redirect(
      `${redirectBase}&message=bulkDeleted&count=${deletedFeedIds.length}`,
    );
  } catch (error) {
    logger.error("Error bulk deleting feeds", { error: String(error) });
    return wantsJson
      ? c.json(
          {
            ok: false,
            error:
              "Server error while deleting feeds. This can happen if Cloudflare is rate-limiting requests or if the Worker hit a plan quota. Please try again.",
          },
          500,
        )
      : c.text("Error bulk deleting feeds. Please try again.", 500);
  }
});
