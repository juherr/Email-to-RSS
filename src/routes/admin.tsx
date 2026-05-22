import { Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Env, FeedConfig } from "../types";
import { csrf } from "hono/csrf";
import { ADMIN_COOKIE_MAX_AGE } from "../config/constants";
import { logger } from "../lib/logger";
import { Layout, clampText } from "./admin/ui";
import { listAllFeeds, updateFeedInList } from "./admin/helpers";
import { feedsRouter } from "./admin/feeds";
import { emailsRouter } from "./admin/emails";
import { dashboardScript } from "../scripts/generated/dashboard";

type AppEnv = { Bindings: Env };

/**
 * Admin routes handler for Email-to-RSS
 * Provides a secure interface for managing RSS feeds and viewing emails
 *
 * Security:
 * - All routes except /login are protected by server-side cookie authentication
 * - Uses HttpOnly cookies to prevent XSS attacks
 * - Implements SameSite=Strict to prevent CSRF attacks
 */
const app = new Hono<AppEnv>();

// Export for testing
export default app;

const ADMIN_COOKIE_NAME = "admin_auth";

// Prevent accidental caching of admin pages and redirects.
app.use("*", async (c, next) => {
  c.header("Cache-Control", "no-store, max-age=0");
  await next();
});

function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Try native timing-safe implementation first (Cloudflare Workers runtime)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = crypto.subtle as any;
  if (typeof subtle.timingSafeEqual === "function") {
    if (aBytes.length !== bBytes.length) return false;
    return subtle.timingSafeEqual(aBytes, bBytes);
  }
  // Constant-time fallback for Node (test environment): encode length
  // mismatch into `diff` so the loop always runs over the full length.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

// Authentication middleware for admin routes
async function authMiddleware(c: Context, next: () => Promise<void>) {
  const env = c.env;
  const path = new URL(c.req.url).pathname;

  // Skip auth check for login page - note that path includes /admin prefix
  if (path === "/admin/login") {
    return next();
  }

  // Proxy auth: only active when both env vars are present
  if (env.PROXY_AUTH_SECRET && env.PROXY_TRUSTED_IPS) {
    const trustedIps = env.PROXY_TRUSTED_IPS.split(",")
      .map((s: string) => s.trim())
      .filter(Boolean);
    const clientIp = c.req.header("CF-Connecting-IP") ?? "";
    const providedSecret = c.req.header("X-Auth-Proxy-Secret") ?? "";
    const remoteUser =
      c.req.header("Remote-User") || c.req.header("X-Forwarded-User") || "";

    if (
      trustedIps.includes(clientIp) &&
      timingSafeEqual(providedSecret, env.PROXY_AUTH_SECRET) &&
      remoteUser.length > 0
    ) {
      return next();
    }
  }

  // Fallback: signed cookie
  const authCookie = await getSignedCookie(
    c,
    env.ADMIN_PASSWORD,
    ADMIN_COOKIE_NAME,
  );
  if (authCookie !== "1") {
    return c.redirect("/admin/login");
  }

  await next();
}

// Apply auth middleware to all admin routes
app.use("*", authMiddleware);

// CSRF middleware: validates Origin header on mutating requests (POST/PUT/DELETE/PATCH)
// Skip on /admin/login — password itself provides protection for the pre-auth route
const csrfMiddleware = csrf({
  origin: (origin, c) => origin === `https://${c.env.DOMAIN}`,
});
app.use("*", (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (path === "/admin/login") return next();
  return csrfMiddleware(c, next);
});

// Schema for feed API updates (title/description only)
const updateFeedSchema = z.object({
  title: z.string().min(1, "Title is required"),
  description: z.string().optional(),
  language: z.string().optional().default("en"),
  allowedSenders: z.array(z.string()).optional().default([]),
});

// Authentication schema
const authSchema = z.object({
  password: z.string().min(1, "Password is required"),
});

// Login page
app.get("/login", (c) => {
  const error = c.req.query("error");
  const errorMessage =
    error === "invalid" ? "Invalid password. Please try again." : "";

  return c.html(
    <Layout title="Login">
      <div class="auth-container fade-in">
        <div class="auth-card">
          <div class="auth-logo">
            <svg
              width="64"
              height="64"
              viewBox="0 0 24 24"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <rect width="24" height="24" rx="12" fill="var(--color-primary)" />
              <path
                d="M17 9C17 7.89543 16.1046 7 15 7H9C7.89543 7 7 7.89543 7 9V15C7 16.1046 7.89543 17 9 17H15C16.1046 17 17 16.1046 17 15V9Z"
                stroke="white"
                stroke-width="1.5"
              />
              <path
                d="M7 9L12 13L17 9"
                stroke="white"
                stroke-width="1.5"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </div>
          <h1 class="auth-title">Email to RSS Admin</h1>
          {errorMessage && (
            <div class="auth-error">{errorMessage}</div>
          )}
          <form class="auth-form" action="/admin/login" method="post">
            <div class="form-group">
              <label for="password">Password</label>
              <input
                type="password"
                id="password"
                name="password"
                required
                autofocus
              />
            </div>
            <button type="submit" class="button auth-button">
              Log In
            </button>
          </form>
        </div>
      </div>
    </Layout>,
  );
});

// Handle login
app.post("/login", async (c) => {
  const env = c.env;

  try {
    const formData = await c.req.formData();
    const password = formData.get("password")?.toString() || "";

    // Validate password
    authSchema.parse({ password });

    // Check password against environment variable
    if (timingSafeEqual(password, env.ADMIN_PASSWORD)) {
      await setSignedCookie(c, ADMIN_COOKIE_NAME, "1", env.ADMIN_PASSWORD, {
        path: "/",
        httpOnly: true,
        sameSite: "Strict",
        secure: true,
        maxAge: ADMIN_COOKIE_MAX_AGE,
      });
      return c.redirect("/admin");
    }

    // Incorrect password - redirect back to login with an error message
    return c.redirect("/admin/login?error=invalid");
  } catch (error) {
    logger.error("Login error", { error: String(error) });
    return c.redirect("/admin/login?error=invalid");
  }
});

// Logout route
app.get("/logout", (c) => {
  deleteCookie(c, ADMIN_COOKIE_NAME, { path: "/" });
  return c.redirect("/admin/login");
});

// dashboardScript is compiled from src/scripts/client/dashboard.ts via `npm run build:client`.
// It is imported from src/scripts/generated/dashboard.ts above.

// ── Shared SVG icons ──────────────────────────────────────────────────────────

const CopyIcon = () => (
  <svg
    class="copy-icon copy-icon-original"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
  </svg>
);

const CheckIcon = () => (
  <svg
    class="copy-icon copy-icon-success"
    width="16"
    height="16"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="2"
    stroke-linecap="round"
    stroke-linejoin="round"
  >
    <path d="M20 6L9 17l-5-5"></path>
  </svg>
);

type CopyFieldInlineProps = {
  value: string;
  emailAddress?: string;
};

const CopyFieldInline = ({ value }: CopyFieldInlineProps) => (
  <div class="copyable copyable-inline">
    <div class="copyable-content">
      <span class="copyable-value" data-copy={value} title={value}>
        {value}
      </span>
      <div class="copy-icon-container">
        <CopyIcon />
        <CheckIcon />
      </div>
    </div>
  </div>
);

// Admin dashboard route
app.get("/", async (c) => {
  // Type assertion for environment variables
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const url = new URL(c.req.url);
  const view = url.searchParams.get("view") === "table" ? "table" : "list";
  const message = url.searchParams.get("message");
  const count = Number(url.searchParams.get("count") || "0");

  // List all feeds
  const feedList = await listAllFeeds(emailStorage);

  // Keep the dashboard fast: avoid N KV reads for N feeds.
  // We store title/description in `feeds:list` (description is optional for older data).
  const feedsWithConfig = feedList.map((feed) => ({
    ...feed,
    description: feed.description || "",
  }));

  const listHref = (() => {
    const nextUrl = new URL(url);
    nextUrl.pathname = "/admin";
    nextUrl.searchParams.set("view", "list");
    const qs = nextUrl.searchParams.toString();
    return `${nextUrl.pathname}${qs ? `?${qs}` : ""}`;
  })();

  const tableHref = (() => {
    const nextUrl = new URL(url);
    nextUrl.pathname = "/admin";
    nextUrl.searchParams.set("view", "table");
    const qs = nextUrl.searchParams.toString();
    return `${nextUrl.pathname}${qs ? `?${qs}` : ""}`;
  })();

  const viewToggle = (
    <div class="segmented" role="tablist" aria-label="Feed view">
      <a
        class={`segmented-item ${view === "list" ? "is-active" : ""}`}
        href={listHref}
        role="tab"
        aria-selected={view === "list" ? "true" : "false"}
      >
        List
      </a>
      <a
        class={`segmented-item ${view === "table" ? "is-active" : ""}`}
        href={tableHref}
        role="tab"
        aria-selected={view === "table" ? "true" : "false"}
      >
        Table
      </a>
    </div>
  );

  return c.html(
    <Layout title="Dashboard">
      <div
        class={`container ${view === "table" ? "container-wide" : ""} fade-in`}
      >
        <div class="header-with-actions">
          <div class="header-title">
            <h1>Email to RSS Admin</h1>
            <p>Manage your email newsletter feeds</p>
          </div>
          <div class="header-actions">
            <a href="/admin/logout" class="button button-logout">
              Logout
            </a>
          </div>
        </div>

        <div class="card">
          <h2>Create New Feed</h2>
          <form action="/admin/feeds/create" method="post">
            <div class="form-group">
              <label for="title">Feed Title</label>
              <input type="text" id="title" name="title" required />
            </div>

            <div class="form-group">
              <label for="description">Description</label>
              <textarea id="description" name="description" rows={3}></textarea>
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
              ></textarea>
              <small>
                When set, inbound emails are only accepted from these
                senders/domains.
              </small>
            </div>

            <input type="hidden" id="language" name="language" value="en" />
            <input type="hidden" name="view" value={view} />

            <button type="submit" class="button">
              Create Feed
            </button>
          </form>
        </div>

        {message === "bulkDeleted" && (
          <div class="card">
            <p>Deleted {Number.isFinite(count) ? count : 0} feed(s).</p>
          </div>
        )}
        {message === "bulkDeleteNoop" && (
          <div class="card">
            <p>No feeds were selected.</p>
          </div>
        )}

        <div class="toolbar">
          <div class="toolbar-group">
            <h2 style="margin: 0;">Your Feeds</h2>
            <span class="pill" id="feed-total-count">
              {feedsWithConfig.length}
            </span>
          </div>
          <div class="toolbar-group">{viewToggle}</div>
        </div>

        {feedsWithConfig.length === 0 ? (
          <div class="card">
            <p>You don't have any feeds yet. Create one above.</p>
          </div>
        ) : view === "table" ? (
          <div class="card">
            <form
              id="bulk-feed-delete-form"
              action="/admin/feeds/bulk-delete"
              method="post"
              onsubmit="return onBulkFeedDeleteSubmit(event)"
            >
              <input type="hidden" name="view" value="table" />

              <div class="toolbar">
                <div class="toolbar-group toolbar-group-fill">
                  <input
                    type="search"
                    id="feed-search"
                    class="search"
                    placeholder="Search title, feed id, or description"
                    oninput="scheduleFeedFilter()"
                  />
                  <span class="pill" id="feed-match-count">
                    Showing {feedsWithConfig.length}
                  </span>
                  <span class="pill" id="selected-feed-count">
                    0 selected
                  </span>
                  <button
                    type="button"
                    class="button button-small button-secondary"
                    onclick="selectMatchingFeeds()"
                  >
                    Select Results
                  </button>
                  <button
                    type="button"
                    class="button button-small button-secondary"
                    onclick="clearFeedSelection()"
                  >
                    Clear Selection
                  </button>
                  <button
                    id="bulk-delete-feeds-button"
                    type="submit"
                    class="button button-small button-danger"
                    disabled
                  >
                    Delete Selected
                  </button>
                </div>
              </div>

              <div class="table-wrap">
                <table class="table table-feeds">
                  <colgroup>
                    <col data-col="select" style="width: 44px;" />
                    <col data-col="title" style="width: 340px;" />
                    <col data-col="feedId" style="width: 160px;" />
                    <col data-col="email" style="width: 220px;" />
                    <col data-col="rss" style="width: 220px;" />
                    <col data-col="actions" style="width: 200px;" />
                  </colgroup>
                  <thead>
                    <tr>
                      <th>
                        <input
                          type="checkbox"
                          id="select-all-feeds"
                          onchange="toggleAllFeeds(this.checked)"
                        />
                      </th>
                      <th
                        class="th-resizable"
                        data-sort-key="title"
                        aria-sort="none"
                      >
                        <button
                          type="button"
                          class="th-button"
                          data-sort-key="title"
                        >
                          Title
                          <span
                            class="sort-indicator"
                            aria-hidden="true"
                          ></span>
                        </button>
                        <div
                          class="col-resizer"
                          data-col="title"
                          title="Resize"
                        ></div>
                      </th>
                      <th
                        class="th-resizable"
                        data-sort-key="feedId"
                        aria-sort="none"
                      >
                        <button
                          type="button"
                          class="th-button"
                          data-sort-key="feedId"
                        >
                          Feed ID
                          <span
                            class="sort-indicator"
                            aria-hidden="true"
                          ></span>
                        </button>
                        <div
                          class="col-resizer"
                          data-col="feedId"
                          title="Resize"
                        ></div>
                      </th>
                      <th
                        class="th-resizable"
                        data-sort-key="email"
                        aria-sort="none"
                      >
                        <button
                          type="button"
                          class="th-button"
                          data-sort-key="email"
                        >
                          Email
                          <span
                            class="sort-indicator"
                            aria-hidden="true"
                          ></span>
                        </button>
                        <div
                          class="col-resizer"
                          data-col="email"
                          title="Resize"
                        ></div>
                      </th>
                      <th
                        class="th-resizable"
                        data-sort-key="rss"
                        aria-sort="none"
                      >
                        <button
                          type="button"
                          class="th-button"
                          data-sort-key="rss"
                        >
                          RSS
                          <span
                            class="sort-indicator"
                            aria-hidden="true"
                          ></span>
                        </button>
                        <div
                          class="col-resizer"
                          data-col="rss"
                          title="Resize"
                        ></div>
                      </th>
                      <th class="th-resizable">
                        <span>Actions</span>
                        <div
                          class="col-resizer"
                          data-col="actions"
                          title="Resize"
                        ></div>
                      </th>
                    </tr>
                  </thead>
                  <tbody id="feed-table-body">
                    {feedsWithConfig.map((feed) => {
                      const emailAddress = `${feed.id}@${env.DOMAIN}`;
                      const rssUrl = `https://${env.DOMAIN}/rss/${feed.id}`;
                      const titleDisplay = clampText(feed.title, 160);
                      const titleHover = clampText(feed.title, 1000);
                      const sortTitle = titleHover.toLowerCase();
                      const sortFeedId = feed.id.toLowerCase();
                      const sortEmail = emailAddress.toLowerCase();
                      const sortRss = rssUrl.toLowerCase();
                      const descDisplay = clampText(feed.description || "", 220);
                      const descHover = clampText(feed.description || "", 1000);
                      const searchHaystack =
                        `${clampText(feed.title, 320)} ${feed.id} ${clampText(feed.description || "", 320)}`.toLowerCase();

                      return (
                        <tr
                          class="feed-row"
                          data-feed-id={feed.id}
                          data-search={searchHaystack}
                          data-sort-title={sortTitle}
                          data-sort-feed-id={sortFeedId}
                          data-sort-email={sortEmail}
                          data-sort-rss={sortRss}
                        >
                          <td>
                            <input
                              type="checkbox"
                              class="feed-select"
                              name="feedIds"
                              value={feed.id}
                              onchange="updateFeedSelectionState()"
                            />
                          </td>
                          <td>
                            <strong class="truncate" title={titleHover}>
                              {titleDisplay}
                            </strong>
                            {feed.description && (
                              <div
                                class="muted truncate"
                                style="font-size: var(--font-size-sm); margin-top: 4px;"
                                title={descHover}
                              >
                                {descDisplay}
                              </div>
                            )}
                          </td>
                          <td>
                            <code>{feed.id}</code>
                          </td>
                          <td>
                            <CopyFieldInline value={emailAddress} />
                          </td>
                          <td>
                            <CopyFieldInline value={rssUrl} />
                          </td>
                          <td>
                            <div class="row-actions">
                              <a
                                href={`/admin/feeds/${feed.id}/edit`}
                                class="button button-small"
                              >
                                Edit
                              </a>
                              <a
                                href={`/admin/feeds/${feed.id}/emails`}
                                class="button button-small"
                              >
                                Emails
                              </a>
                              <button
                                type="button"
                                class="button button-small button-danger button-delete"
                                data-delete-kind="feed"
                                data-feed-id={feed.id}
                                data-view="table"
                              >
                                Delete
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </form>
          </div>
        ) : (
          <>
            <div class="toolbar">
              <div class="toolbar-group toolbar-group-fill">
                <input
                  type="search"
                  id="feed-search"
                  class="search"
                  placeholder="Search title, feed id, or description"
                  oninput="scheduleFeedFilter()"
                />
                <span class="pill">Tip: use Table view for bulk deletion.</span>
              </div>
            </div>

            <ul class="feed-list">
              {feedsWithConfig.map((feed) => {
                const emailAddress = `${feed.id}@${env.DOMAIN}`;
                const rssUrl = `https://${env.DOMAIN}/rss/${feed.id}`;
                const titleDisplay = clampText(feed.title, 140);
                const titleHover = clampText(feed.title, 1000);
                const descDisplay = clampText(feed.description || "", 240);
                const descHover = clampText(feed.description || "", 1000);
                const searchHaystack =
                  `${clampText(feed.title, 320)} ${feed.id} ${clampText(feed.description || "", 320)}`.toLowerCase();

                return (
                  <li
                    class="feed-item card feed-row"
                    data-feed-id={feed.id}
                    data-search={searchHaystack}
                  >
                    <div class="feed-header">
                      <h3 class="feed-title" title={titleHover}>
                        {titleDisplay}
                      </h3>
                      {feed.description && (
                        <p class="feed-description">
                          <span title={descHover}>{descDisplay}</span>
                        </p>
                      )}
                    </div>

                    <div style="margin-bottom: var(--spacing-md);">
                      <div class="copyable">
                        <span class="copyable-label">Email:</span>
                        <div class="copyable-content">
                          <span
                            class="copyable-value"
                            data-copy={emailAddress}
                            title={emailAddress}
                          >
                            {emailAddress}
                          </span>
                          <div class="copy-icon-container">
                            <CopyIcon />
                            <CheckIcon />
                          </div>
                        </div>
                      </div>
                      <div class="copyable">
                        <span class="copyable-label">RSS Feed:</span>
                        <div class="copyable-content">
                          <span
                            class="copyable-value"
                            data-copy={rssUrl}
                            title={rssUrl}
                          >
                            {rssUrl}
                          </span>
                          <div class="copy-icon-container">
                            <CopyIcon />
                            <CheckIcon />
                          </div>
                        </div>
                      </div>
                    </div>

                    <div class="feed-buttons">
                      <div class="feed-buttons-left">
                        <a
                          href={`/admin/feeds/${feed.id}/edit`}
                          class="button button-small"
                        >
                          Edit
                        </a>
                        <a
                          href={`/admin/feeds/${feed.id}/emails`}
                          class="button button-small"
                        >
                          Emails
                        </a>
                      </div>
                      <div class="feed-buttons-right">
                        <button
                          type="button"
                          class="button button-small button-danger button-delete"
                          data-delete-kind="feed"
                          data-feed-id={feed.id}
                          data-view="list"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>

      <script dangerouslySetInnerHTML={{ __html: dashboardScript }} />
    </Layout>,
  );
});

// Mount sub-routers
app.route("/feeds", feedsRouter);
app.route("/", emailsRouter);

// Update feed via API (for in-place editing)
app.post(
  "/api/feeds/:feedId/update",
  zValidator(
    "json",
    updateFeedSchema.pick({ title: true, description: true }),
    (result, c) => {
      if (!result.success)
        return c.json({ success: false, error: result.error.issues }, 400);
    },
  ),
  async (c) => {
    // Type assertion for environment variables
    const env = c.env;
    const emailStorage = env.EMAIL_STORAGE;
    const feedId = c.req.param("feedId");

    try {
      const { title, description } = c.req.valid("json");
      const parsedData = { title, description, language: "en" as const };

      // Get existing feed config
      const feedConfigKey = `feed:${feedId}:config`;
      const existingConfig = (await emailStorage.get(feedConfigKey, {
        type: "json",
      })) as FeedConfig | null;

      if (!existingConfig) {
        return c.json({ error: "Feed not found" }, 404);
      }

      // Update feed configuration
      await emailStorage.put(
        feedConfigKey,
        JSON.stringify({
          ...existingConfig,
          title: parsedData.title,
          description: parsedData.description,
          updated_at: Date.now(),
        }),
      );

      // Update feed in the list of all feeds
      await updateFeedInList(
        emailStorage,
        feedId,
        parsedData.title,
        parsedData.description,
      );

      // Return success response
      return c.json({ success: true });
    } catch (error) {
      logger.error("Error updating feed via API", { error: String(error) });
      return c.json({ error: "Error updating feed" }, 400);
    }
  },
);

// Export the Hono app
export const handle = app;
