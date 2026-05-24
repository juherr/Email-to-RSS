import { Hono } from "hono";
import { z } from "zod";
import { Env } from "../../types";
import { bumpCounters } from "../../application/stats";
import { waitUntilSafe } from "../../infrastructure/worker";
import { feedRssUrl, feedEmailAddress } from "../../infrastructure/urls";
import { logger } from "../../infrastructure/logger";
import { sendUnsubscribes } from "../../infrastructure/unsubscribe";
import { getAttachmentBucket } from "../../infrastructure/attachments";
import { Layout } from "./ui";
import {
  purgeFeedKeysStep,
  collectUnsubscribeUrls,
} from "../../application/feed-cleanup";
import { FeedRepository } from "../../infrastructure/feed-repository";
import { FeedId } from "../../domain/value-objects/feed-id";
import {
  createFeedRecord,
  editFeed,
  deleteFeedRecord,
  deleteFeedFastDetailed,
} from "../../application/feed-service";

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
  action: z.enum([
    "allow_sender",
    "allow_domain",
    "block_sender",
    "block_domain",
  ]),
  value: z.string().min(1),
});

// ── Routes ────────────────────────────────────────────────────────────────────

feedsRouter.post("/create", async (c) => {
  const env = c.env;
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

    const lifetimeHours = lifetimeHoursRaw
      ? parseInt(lifetimeHoursRaw, 10)
      : undefined;

    const { feedId } = await createFeedRecord(env, {
      title: parsedData.title,
      description: parsedData.description,
      language: parsedData.language,
      allowedSenders: parsedData.allowedSenders,
      blockedSenders: parsedData.blockedSenders,
      lifetimeHours,
    });

    if (isJson) {
      return c.json({
        feedId,
        email: feedEmailAddress(feedId, env),
        feedUrl: feedRssUrl(feedId, env),
      });
    }

    return c.redirect(`/admin?view=${view}#your-feeds`);
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
  const feedId = c.req.param("feedId");

  const feedConfig = await FeedRepository.from(env).getConfig(
    FeedId.unchecked(feedId),
  );

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

    const result = await editFeed(env, FeedId.unchecked(feedId), {
      title: parsedData.title,
      description: parsedData.description,
      language: parsedData.language,
      allowedSenders: parsedData.allowedSenders,
      blockedSenders: parsedData.blockedSenders,
      lifetimeHours: lifetimeHoursRaw
        ? parseInt(lifetimeHoursRaw, 10)
        : undefined,
    });

    if (result.status === "not_found") {
      return c.text("Feed not found", 404);
    }
    if (result.status === "expired") {
      return c.text("Feed has expired and cannot be modified.", 403);
    }

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
  const id = FeedId.unchecked(feedId);
  const repo = FeedRepository.from(env);

  const body = await c.req.json().catch(() => null);
  const parsed = senderFilterSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ ok: false, error: "Invalid request" }, 400);
  }

  const { action, value } = parsed.data;
  const normalized = value.trim().toLowerCase();

  const feedConfig = await repo.getConfig(id);
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
    await repo.putConfig(id, {
      ...feedConfig,
      allowed_senders: allowedSenders,
      blocked_senders: blockedSenders,
      updated_at: Date.now(),
    });
  }

  return c.json({ ok: true });
});

feedsRouter.post("/:feedId/delete", async (c) => {
  const env = c.env;
  const feedId = c.req.param("feedId");
  const view = c.req.query("view") === "table" ? "table" : "list";
  const wantsJson = (c.req.header("Accept") || "").includes("application/json");

  try {
    await deleteFeedRecord(env, FeedId.unchecked(feedId), (p) =>
      waitUntilSafe(c, p),
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

    const step = await purgeFeedKeysStep(
      emailStorage,
      FeedId.unchecked(feedId),
      {
        cursor,
        limit,
        bucket: getAttachmentBucket(env),
      },
    );

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
      const unsubscribeUrls: string[] = [];

      for (const feedId of parsedFeedIds) {
        try {
          const id = FeedId.unchecked(feedId);
          // Read unsubscribe URLs before the feed metadata is deleted.
          const urls = await collectUnsubscribeUrls(emailStorage, id);
          const result = await deleteFeedFastDetailed(emailStorage, id);
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

          unsubscribeUrls.push(...urls);
          okIds.push(feedId);
        } catch (error) {
          logger.error("Error bulk deleting feed", {
            feedId,
            error: String(error),
          });
          failures.push({ feedId, error: String(error) });
        }
      }

      const deletedFeedIds = await new FeedRepository(
        emailStorage,
      ).removeFromListBulk(okIds);
      if (deletedFeedIds.length > 0) {
        await bumpCounters(emailStorage, {
          feeds_deleted: deletedFeedIds.length,
        });
      }

      if (unsubscribeUrls.length > 0) {
        waitUntilSafe(c, sendUnsubscribes(unsubscribeUrls, env));
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
    const unsubscribeUrls: string[] = [];

    for (const feedId of parsedFeedIds) {
      try {
        const id = FeedId.unchecked(feedId);
        // Read unsubscribe URLs before the feed metadata is deleted.
        const urls = await collectUnsubscribeUrls(emailStorage, id);
        const result = await deleteFeedFastDetailed(emailStorage, id);
        if (result.ok) {
          unsubscribeUrls.push(...urls);
          okIds.push(feedId);
        }
      } catch (error) {
        logger.error("Error bulk deleting feed", {
          feedId,
          error: String(error),
        });
      }
    }

    const deletedFeedIds = await new FeedRepository(
      emailStorage,
    ).removeFromListBulk(okIds);
    if (deletedFeedIds.length > 0) {
      await bumpCounters(emailStorage, {
        feeds_deleted: deletedFeedIds.length,
      });
    }

    if (unsubscribeUrls.length > 0) {
      waitUntilSafe(c, sendUnsubscribes(unsubscribeUrls, env));
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
