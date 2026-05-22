import { Hono } from "hono";
import { z } from "zod";
import { Env, FeedConfig, FeedMetadata, EmailData } from "../../types";
import { generateFeedId } from "../../utils/id-generator";
import { waitUntilSafe } from "../../utils/worker";
import { logger } from "../../lib/logger";
import { Layout } from "./ui";
import {
  addFeedToList,
  updateFeedInList,
  removeFeedFromList,
  removeFeedsFromListBulk,
  deleteKeysWithConcurrency,
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
});

const updateFeedSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  language: z.string().optional().default("en"),
  allowedSenders: z.array(z.string()).optional().default([]),
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

async function purgeFeedKeysStep(
  emailStorage: KVNamespace,
  feedId: string,
  options: { cursor?: string; limit?: number; bucket?: R2Bucket } = {},
): Promise<{
  deletedKeys: string[];
  failedKeys: string[];
  cursor: string;
  listComplete: boolean;
}> {
  const prefix = `feed:${feedId}:`;
  const limit = Math.min(1000, Math.max(1, Math.floor(options.limit || 100)));
  const cursor = options.cursor || undefined;

  const listed = await emailStorage.list({ prefix, cursor, limit });
  const keys = (listed.keys || []).map((k) => k.name);

  if (options.bucket && keys.length > 0) {
    const emailKeys = keys.filter((k) => {
      const suffix = k.slice(prefix.length);
      return suffix !== "config" && suffix !== "metadata";
    });
    if (emailKeys.length > 0) {
      const emailDataResults = await Promise.allSettled(
        emailKeys.map(
          (k) =>
            emailStorage.get(k, { type: "json" }) as Promise<EmailData | null>,
        ),
      );
      const attachmentIds = emailDataResults
        .filter(
          (r): r is PromiseFulfilledResult<EmailData | null> =>
            r.status === "fulfilled",
        )
        .flatMap((r) => r.value?.attachments?.map((a) => a.id) ?? []);
      if (attachmentIds.length > 0) {
        await Promise.allSettled(
          attachmentIds.map((id) => options.bucket!.delete(id)),
        );
      }
    }
  }

  const { ok, failed } = await deleteKeysWithConcurrency(
    emailStorage,
    keys,
    35,
  );

  return {
    deletedKeys: ok,
    failedKeys: failed,
    cursor: listed.cursor || "",
    listComplete: !!listed.list_complete,
  };
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
    } else {
      const formData = await c.req.formData();
      title = formData.get("title")?.toString() || "";
      description = formData.get("description")?.toString();
      language = formData.get("language")?.toString() || "en";
      view = formData.get("view")?.toString() === "table" ? "table" : "list";
      allowedSenders = parseAllowedSenders(
        formData.get("allowed_senders")?.toString() || "",
      );
    }

    const parsedData = createFeedSchema.parse({
      title,
      description,
      language,
      allowedSenders,
    });

    const feedId = generateFeedId();

    const feedConfig: FeedConfig = {
      title: parsedData.title,
      description: parsedData.description,
      language: parsedData.language,
      site_url: `https://${env.DOMAIN}/rss/${feedId}`,
      feed_url: `https://${env.DOMAIN}/rss/${feedId}`,
      allowed_senders: parsedData.allowedSenders,
      created_at: Date.now(),
      updated_at: Date.now(),
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
    );

    if (isJson) {
      return c.json({
        feedId,
        email: `${feedId}@${env.DOMAIN}`,
        feedUrl: feedConfig.feed_url,
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

        <div class="card">
          <form action={`/admin/feeds/${feedId}/edit`} method="post">
            <div class="form-group">
              <label for="title">Feed Title</label>
              <input
                type="text"
                id="title"
                name="title"
                value={feedConfig.title}
                required
              />
            </div>

            <div class="form-group">
              <label for="description">Description</label>
              <textarea id="description" name="description" rows={3}>
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
              >
                {(feedConfig.allowed_senders || []).join("\n")}
              </textarea>
              <small>
                When set, inbound emails are only accepted from these
                senders/domains.
              </small>
            </div>

            <input type="hidden" id="language" name="language" value="en" />

            <button type="submit" class="button">
              Update Feed
            </button>
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

    const parsedData = updateFeedSchema.parse({
      title,
      description,
      language,
      allowedSenders,
    });

    const feedConfigKey = `feed:${feedId}:config`;
    const existingConfig = (await emailStorage.get(feedConfigKey, {
      type: "json",
    })) as FeedConfig | null;

    if (!existingConfig) {
      return c.text("Feed not found", 404);
    }

    await emailStorage.put(
      feedConfigKey,
      JSON.stringify({
        ...existingConfig,
        title: parsedData.title,
        description: parsedData.description,
        language: parsedData.language,
        allowed_senders: parsedData.allowedSenders,
        updated_at: Date.now(),
      }),
    );

    await updateFeedInList(
      emailStorage,
      feedId,
      parsedData.title,
      parsedData.description,
    );

    return c.redirect("/admin");
  } catch (error) {
    logger.error("Error updating feed", { feedId, error: String(error) });
    return c.text("Error updating feed. Please try again.", 400);
  }
});

feedsRouter.post("/:feedId/delete", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");
  const view = c.req.query("view") === "table" ? "table" : "list";
  const wantsJson = (c.req.header("Accept") || "").includes("application/json");

  try {
    await deleteFeedFast(emailStorage, feedId);
    await removeFeedFromList(emailStorage, feedId);

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
