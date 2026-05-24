import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { cors } from "hono/cors";
import { Scalar } from "@scalar/hono-api-reference";
import { Env, FeedConfig } from "../../types";
import { apiAuthMiddleware } from "../../infrastructure/auth";
import {
  createFeedRecord,
  editFeed,
  deleteFeedRecord,
} from "../../application/feed-service";
import { deleteAttachmentsForEmails } from "../../application/feed-cleanup";
import { waitUntilSafe } from "../../infrastructure/worker";
import { FeedRepository } from "../../infrastructure/feed-repository";
import { FeedId } from "../../domain/value-objects/feed-id";
import { getStats } from "../../application/stats";
import {
  feedEmailAddress,
  feedRssUrl,
  feedAtomUrl,
} from "../../infrastructure/urls";
import {
  ErrorSchema,
  FeedIdParam,
  EntryIdParam,
  FeedCreateSchema,
  FeedUpdateSchema,
  FeedSchema,
  FeedListSchema,
  EmailListSchema,
  EmailSchema,
  StatsSchema,
} from "./schemas";

type AppEnv = { Bindings: Env };

const OkSchema = z.object({ ok: z.boolean() }).openapi("Ok");

const jsonContent = <T>(schema: T, description: string) => ({
  content: { "application/json": { schema } },
  description,
});

const bearer = [{ bearerAuth: [] }];

function normalizeSenders(senders?: string[]): string[] | undefined {
  return senders?.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

function toFeed(
  id: string,
  config: FeedConfig,
  emailCount: number,
  env: Env,
): z.infer<typeof FeedSchema> {
  return {
    id,
    title: config.title,
    description: config.description,
    language: config.language,
    allowedSenders: config.allowed_senders ?? [],
    blockedSenders: config.blocked_senders ?? [],
    createdAt: config.created_at,
    updatedAt: config.updated_at,
    expiresAt: config.expires_at,
    emailCount,
    emailAddress: feedEmailAddress(config.mailbox_id, env),
    rssUrl: feedRssUrl(id, env),
    atomUrl: feedAtomUrl(id, env),
  };
}

export const apiApp = new OpenAPIHono<AppEnv>({
  defaultHook: (result, c) => {
    if (!result.success) {
      const message = result.error.issues
        .map((i) => `${i.path.join(".")}: ${i.message}`)
        .join("; ");
      return c.json({ error: `Validation failed: ${message}` }, 400);
    }
  },
});

// Token auth on the feed/email routes. The spec, docs, and /v1/stats stay public.
apiApp.use("/v1/feeds", apiAuthMiddleware);
apiApp.use("/v1/feeds/*", apiAuthMiddleware);

// Public monitoring stats — readable from any origin (landing page, embeds).
apiApp.use("/v1/stats", cors({ origin: "*" }));

apiApp.openAPIRegistry.registerComponent("securitySchemes", "bearerAuth", {
  type: "http",
  scheme: "bearer",
  description: "Use the admin password as the bearer token.",
});

// ── Feeds ─────────────────────────────────────────────────────────────────────

apiApp.openapi(
  createRoute({
    method: "get",
    path: "/v1/feeds",
    tags: ["Feeds"],
    summary: "List all feeds",
    security: bearer,
    responses: {
      200: jsonContent(FeedListSchema, "The list of feeds"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
    },
  }),
  async (c) => {
    const env = c.env;
    const feeds = await FeedRepository.from(env).listFeeds();
    return c.json(
      {
        feeds: feeds.map((f) => ({
          id: f.id,
          title: f.title,
          description: f.description,
          expiresAt: f.expires_at,
          emailAddress: feedEmailAddress(f.mailbox_id, env),
          rssUrl: feedRssUrl(f.id, env),
          atomUrl: feedAtomUrl(f.id, env),
        })),
      },
      200,
    );
  },
);

apiApp.openapi(
  createRoute({
    method: "post",
    path: "/v1/feeds",
    tags: ["Feeds"],
    summary: "Create a feed",
    security: bearer,
    request: {
      body: { content: { "application/json": { schema: FeedCreateSchema } } },
    },
    responses: {
      201: jsonContent(FeedSchema, "The created feed"),
      400: jsonContent(ErrorSchema, "Invalid request body"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
    },
  }),
  async (c) => {
    const env = c.env;
    const body = c.req.valid("json");
    const { feedId, config } = await createFeedRecord(env, {
      title: body.title,
      description: body.description,
      language: body.language,
      allowedSenders: normalizeSenders(body.allowedSenders) ?? [],
      blockedSenders: normalizeSenders(body.blockedSenders) ?? [],
      lifetimeHours: body.lifetimeHours,
    });
    return c.json(toFeed(feedId, config, 0, env), 201);
  },
);

apiApp.openapi(
  createRoute({
    method: "get",
    path: "/v1/feeds/{feedId}",
    tags: ["Feeds"],
    summary: "Get a feed",
    security: bearer,
    request: { params: FeedIdParam },
    responses: {
      200: jsonContent(FeedSchema, "The feed"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Feed not found"),
    },
  }),
  async (c) => {
    const env = c.env;
    const { feedId } = c.req.valid("param");
    const repo = FeedRepository.from(env);
    const id = FeedId.unchecked(feedId);
    const config = await repo.getConfig(id);
    if (!config) return c.json({ error: "Feed not found" }, 404);
    const metadata = await repo.getMetadata(id);
    return c.json(
      toFeed(feedId, config, metadata?.emails.length ?? 0, env),
      200,
    );
  },
);

apiApp.openapi(
  createRoute({
    method: "patch",
    path: "/v1/feeds/{feedId}",
    tags: ["Feeds"],
    summary: "Update a feed",
    security: bearer,
    request: {
      params: FeedIdParam,
      body: { content: { "application/json": { schema: FeedUpdateSchema } } },
    },
    responses: {
      200: jsonContent(FeedSchema, "The updated feed"),
      400: jsonContent(ErrorSchema, "Invalid request body"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Feed not found"),
      409: jsonContent(ErrorSchema, "Feed has expired"),
    },
  }),
  async (c) => {
    const env = c.env;
    const { feedId } = c.req.valid("param");
    const id = FeedId.unchecked(feedId);
    const body = c.req.valid("json");
    const result = await editFeed(env, id, {
      title: body.title,
      description: body.description,
      language: body.language,
      allowedSenders: normalizeSenders(body.allowedSenders),
      blockedSenders: normalizeSenders(body.blockedSenders),
      lifetimeHours: body.lifetimeHours,
    });
    if (result.status === "not_found")
      return c.json({ error: "Feed not found" }, 404);
    if (result.status === "expired")
      return c.json({ error: "Feed has expired and cannot be modified" }, 409);
    const metadata = await FeedRepository.from(env).getMetadata(id);
    return c.json(
      toFeed(feedId, result.config, metadata?.emails.length ?? 0, env),
      200,
    );
  },
);

apiApp.openapi(
  createRoute({
    method: "delete",
    path: "/v1/feeds/{feedId}",
    tags: ["Feeds"],
    summary: "Delete a feed",
    security: bearer,
    request: { params: FeedIdParam },
    responses: {
      200: jsonContent(OkSchema, "The feed was deleted"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Feed not found"),
    },
  }),
  async (c) => {
    const env = c.env;
    const { feedId } = c.req.valid("param");
    const removed = await deleteFeedRecord(env, FeedId.unchecked(feedId), (p) =>
      waitUntilSafe(c, p),
    );
    if (!removed) return c.json({ error: "Feed not found" }, 404);
    return c.json({ ok: true }, 200);
  },
);

// ── Emails ──────────────────────────────────────────────────────────────────

apiApp.openapi(
  createRoute({
    method: "get",
    path: "/v1/feeds/{feedId}/emails",
    tags: ["Emails"],
    summary: "List a feed's emails",
    security: bearer,
    request: { params: FeedIdParam },
    responses: {
      200: jsonContent(EmailListSchema, "The feed's emails"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Feed not found"),
    },
  }),
  async (c) => {
    const env = c.env;
    const { feedId } = c.req.valid("param");
    const metadata = await FeedRepository.from(env).getMetadata(
      FeedId.unchecked(feedId),
    );
    if (!metadata) return c.json({ error: "Feed not found" }, 404);
    return c.json(
      {
        emails: metadata.emails.map((e) => ({
          entryId: e.receivedAt,
          subject: e.subject,
          receivedAt: e.receivedAt,
          size: e.size,
          attachmentIds: e.attachmentIds,
        })),
      },
      200,
    );
  },
);

apiApp.openapi(
  createRoute({
    method: "get",
    path: "/v1/feeds/{feedId}/emails/{entryId}",
    tags: ["Emails"],
    summary: "Get a single email",
    security: bearer,
    request: { params: EntryIdParam },
    responses: {
      200: jsonContent(EmailSchema, "The email"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Email not found"),
    },
  }),
  async (c) => {
    const env = c.env;
    const { feedId, entryId } = c.req.valid("param");
    const receivedAt = parseInt(entryId, 10);
    const repo = FeedRepository.from(env);
    const metadata = await repo.getMetadata(FeedId.unchecked(feedId));
    const metaEntry = metadata?.emails.find((e) => e.receivedAt === receivedAt);
    if (!metaEntry) return c.json({ error: "Email not found" }, 404);
    const data = await repo.getEmail(metaEntry.key);
    if (!data) return c.json({ error: "Email not found" }, 404);
    return c.json(
      {
        entryId: receivedAt,
        subject: data.subject,
        from: data.from,
        receivedAt: data.receivedAt,
        content: data.content,
        attachments: (data.attachments ?? [])
          .filter((a) => !a.inline)
          .map((a) => ({
            id: a.id,
            filename: a.filename,
            contentType: a.contentType,
            size: a.size,
            url: `/files/${a.id}/${encodeURIComponent(a.filename)}`,
          })),
      },
      200,
    );
  },
);

apiApp.openapi(
  createRoute({
    method: "delete",
    path: "/v1/feeds/{feedId}/emails/{entryId}",
    tags: ["Emails"],
    summary: "Delete a single email",
    security: bearer,
    request: { params: EntryIdParam },
    responses: {
      200: jsonContent(OkSchema, "The email was deleted"),
      401: jsonContent(ErrorSchema, "Unauthorized"),
      404: jsonContent(ErrorSchema, "Email not found"),
    },
  }),
  async (c) => {
    const env = c.env;
    const repo = FeedRepository.from(env);
    const { feedId, entryId } = c.req.valid("param");
    const receivedAt = parseInt(entryId, 10);
    const feed = await repo.load(FeedId.unchecked(feedId));
    const metaEntry = feed?.emails.find((e) => e.receivedAt === receivedAt);
    if (!feed || !metaEntry) return c.json({ error: "Email not found" }, 404);

    await repo.deleteEmail(metaEntry.key);
    const { removed } = feed.removeEmails([metaEntry.key]);
    await deleteAttachmentsForEmails(env, removed, [metaEntry.key]);
    await repo.saveMetadata(feed);

    return c.json({ ok: true }, 200);
  },
);

// ── Stats ─────────────────────────────────────────────────────────────────────

apiApp.openapi(
  createRoute({
    method: "get",
    path: "/v1/stats",
    tags: ["Stats"],
    summary: "Read monitoring counters (public)",
    responses: {
      200: jsonContent(StatsSchema, "Monitoring counters"),
    },
  }),
  async (c) => {
    return c.json(await getStats(c.env), 200);
  },
);

// ── OpenAPI document + docs (public) ───────────────────────────────────────────

apiApp.doc31("/openapi.json", {
  openapi: "3.1.0",
  info: {
    title: "kill-the-news API",
    version: "1.0.0",
    description:
      "REST API for managing email-to-RSS feeds, their emails, and monitoring counters.",
  },
  servers: [{ url: "/api" }],
});

apiApp.get(
  "/docs",
  Scalar({
    url: "/api/openapi.json",
    pageTitle: "kill-the-news API",
  }),
);
