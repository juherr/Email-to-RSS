import { Hono } from "hono";
import { cors } from "hono/cors";
import { handle as handleInbound } from "./routes/inbound";
import { handle as handleRSS } from "./routes/rss";
import { handle as handleAtom } from "./routes/atom";
import { handle as handleAdmin } from "./routes/admin";
import { handle as handleEntry } from "./routes/entries";
import { handle as handleFiles } from "./routes/files";
import { hubRouter } from "./routes/hub";
import { handleCloudflareEmail } from "./lib/cloudflare-email";
import { Env } from "./types";
import { logger } from "./lib/logger";
import { FORWARD_EMAIL_IPS_CACHE_TTL_MS } from "./config/constants";

type AppEnv = { Bindings: Env };

const ALLOWED_ORIGINS = ["https://getmynews.app", "https://www.getmynews.app"];

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
app.route("/rss", rss);
app.route("/atom", atom);
app.route("/entries", entries);
app.route("/files", files);
app.route("/admin", admin);
app.route("/hub", hubRouter);

// Health check endpoint for monitoring
app.get("/health", (c) => c.json({ status: "ok", timestamp: Date.now() }));

// Root path redirects to admin dashboard
app.get("/", (c) => c.redirect("/admin"));

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
    let cursor: string | undefined;
    let deleted = 0;
    do {
      const result = await env.EMAIL_STORAGE.list({ cursor });
      await Promise.all(
        result.keys.map(({ name }) => env.EMAIL_STORAGE.delete(name)),
      );
      deleted += result.keys.length;
      cursor = result.list_complete ? undefined : result.cursor;
    } while (cursor);
    logger.info("Demo KV reset complete", { deleted });
  },
};
