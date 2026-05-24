import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle as handleInbound } from "./routes/inbound";
import { handle as handleRSS } from "./routes/rss";
import { handle as handleAtom } from "./routes/atom";
import { handle as handleAdmin } from "./routes/admin";
import { handle as handleEntry } from "./routes/entries";
import { handle as handleFiles } from "./routes/files";
import { handle as handleHome } from "./routes/home";
import { handle as handleFavicon, handleFeedFavicon } from "./routes/favicon";
import { hubRouter } from "./routes/hub";
import { apiApp } from "./routes/api";
import { handleCloudflareEmail } from "./infrastructure/cloudflare-email";
import { Env } from "./types";
import { logger } from "./infrastructure/logger";
import { FeedRepository } from "./infrastructure/feed-repository";
import { purgeExpiredFeeds } from "./routes/admin/helpers";
import {
  bumpCounters,
  scanR2Usage,
  scanKvUsage,
  setStorageSnapshot,
} from "./application/stats";
import { getAttachmentBucket } from "./infrastructure/attachments";
import { FORWARD_EMAIL_IPS_CACHE_TTL_MS } from "./config/constants";

type AppEnv = { Bindings: Env };

const ALLOWED_ORIGINS = ["https://kill-the.news", "https://www.kill-the.news"];

// Fallback ForwardEmail.net IP addresses in case API fetch fails
const FALLBACK_FORWARD_EMAIL_IPS = [
  "138.197.213.185", // mx1.forwardemail.net
  "121.127.44.56", // mx1.forwardemail.net (alternate)
  "104.248.224.170", // mx2.forwardemail.net
];

// Create the main Hono app
const app = new Hono<AppEnv>();

// Cache for ForwardEmail.net IPs with expiration
let forwardEmailIpsCache: {
  ips: string[];
  expiresAt: number;
} | null = null;

// Function to fetch ForwardEmail.net IPs from their API
async function getForwardEmailIps(): Promise<string[]> {
  try {
    // Return from cache if available and not expired
    if (forwardEmailIpsCache && forwardEmailIpsCache.expiresAt > Date.now()) {
      return forwardEmailIpsCache.ips;
    }

    // Fetch the latest IPs from ForwardEmail.net
    const response = await fetch("https://forwardemail.net/ips/v4.json", {
      headers: {
        "User-Agent": "Email-to-RSS/1.0",
      },
      cf: {
        cacheTtl: 3600, // Cache for 1 hour in Cloudflare's cache
        cacheEverything: true,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch IPs: ${response.status}`);
    }

    // Define the expected type for the API response
    interface IpEntry {
      hostname: string;
      ipv4: string[];
      updated: string;
    }

    const data = (await response.json()) as IpEntry[];

    // Extract IPs for mx1 and mx2 servers
    const mxIps = data
      .filter(
        (entry) =>
          entry.hostname === "mx1.forwardemail.net" ||
          entry.hostname === "mx2.forwardemail.net",
      )
      .flatMap((entry) => entry.ipv4);

    forwardEmailIpsCache = {
      ips: mxIps,
      expiresAt: Date.now() + FORWARD_EMAIL_IPS_CACHE_TTL_MS,
    };

    logger.info("Fetched ForwardEmail.net IPs", { count: mxIps.length });
    return mxIps;
  } catch (error) {
    logger.error("Failed to fetch ForwardEmail.net IPs", {
      error: String(error),
    });
    // Return fallback IPs if fetch fails
    return FALLBACK_FORWARD_EMAIL_IPS;
  }
}

app.use(
  "*",
  cors({
    origin: ALLOWED_ORIGINS,
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
    maxAge: 86400,
  }),
);

// Group routes by functionality
const api = new Hono<AppEnv>();
const rss = new Hono<AppEnv>();
const atom = new Hono<AppEnv>();
const entries = new Hono<AppEnv>();
const files = new Hono<AppEnv>();
const admin = new Hono<AppEnv>();

// Webhook security middleware for /inbound - verify ForwardEmail.net IP
api.use("/inbound", async (c, next) => {
  // Get the client IP
  const clientIP =
    c.req.header("CF-Connecting-IP") || // Cloudflare-specific header
    c.req.header("X-Forwarded-For")?.split(",")[0].trim() ||
    c.req.raw.headers.get("x-real-ip") ||
    "0.0.0.0";

  // Get the latest ForwardEmail.net IPs
  const allowedIps = await getForwardEmailIps();

  // Check if the request is coming from ForwardEmail.net
  if (!allowedIps.includes(clientIP)) {
    logger.warn("Unauthorized webhook request", { clientIP });
    return c.text("Unauthorized", 401);
  }

  logger.info("Authorized webhook request", { clientIP });
  await next();
});

// API routes (inbound webhook)
api.post("/inbound", handleInbound);

// RSS feed routes (public)
rss.get("/:feedId", handleRSS);

// Atom feed routes (public)
atom.get("/:feedId", handleAtom);

// Email entry HTML view (public)
entries.get("/:feedId/:entryId", handleEntry);

// Attachment file serving (public)
files.get("/:attachmentId/:filename", handleFiles);

// Admin routes (protected)
admin.route("/", handleAdmin);

// Mount the route groups
app.route("/api", api);
// Versioned REST API + OpenAPI spec/docs (/api/v1/*, /api/openapi.json, /api/docs)
app.route("/api", apiApp);
app.route("/rss", rss);
app.route("/atom", atom);
app.route("/entries", entries);
app.route("/files", files);
app.route("/admin", admin);
app.route("/hub", hubRouter);

// Project favicon (also the fallback for the per-feed favicon)
app.get("/favicon.svg", handleFavicon);
app.get("/favicon.ico", handleFavicon); // readers/browsers that hardcode .ico

// Per-feed favicon derived from the last sender's domain
app.get("/favicon/:feedId", handleFeedFavicon);

// Health check endpoint for monitoring
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

// Public status page (counters + link to admin)
app.get("/", handleHome);

// Catch-all for 404s
app.all("*", (c) => c.text("Not Found", 404));

// Export both the HTTP fetch handler and the Cloudflare Email handler
export default {
  fetch: app.fetch.bind(app),
  async email(
    message: ForwardableEmailMessage,
    env: Env,
    ctx: ExecutionContext,
  ) {
    await handleCloudflareEmail(message, env, ctx);
  },
  async scheduled(_event: ScheduledEvent, env: Env, _ctx: ExecutionContext) {
    const attachmentBucket = getAttachmentBucket(env);
    const repo = FeedRepository.from(env);
    const feeds = await repo.listFeeds();
    const now = Date.now();
    const expiredIds = feeds
      .filter((f) => f.expires_at !== undefined && f.expires_at <= now)
      .map((f) => f.id);

    for (const feedId of expiredIds) {
      await purgeExpiredFeeds(env.EMAIL_STORAGE, feedId, attachmentBucket);
    }
    if (expiredIds.length > 0) {
      await repo.removeFromListBulk(expiredIds);
      await bumpCounters(env.EMAIL_STORAGE, {
        feeds_deleted: expiredIds.length,
      });
      logger.info("Feed TTL cleanup", { deleted: expiredIds.length });
    }

    // Refresh the cached storage-usage snapshot for the status page / /api/v1/stats.
    try {
      const r2 = attachmentBucket
        ? await scanR2Usage(attachmentBucket)
        : { bytes: 0, count: 0 };
      const kv = await scanKvUsage(env.EMAIL_STORAGE);
      await setStorageSnapshot(env.EMAIL_STORAGE, {
        attachments_bytes: r2.bytes,
        attachments_count: r2.count,
        kv_bytes_estimated: kv.bytes,
      });
    } catch (error) {
      logger.error("Error refreshing storage snapshot", {
        error: String(error),
      });
    }
  },
};
