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

// The large inline script for the dashboard page
const dashboardScript = `
        let FEED_ROWS = [];
        let FEED_CHECKBOXES = [];
        let FEED_SELECTED_COUNT_EL = null;
        let FEED_MATCH_COUNT_EL = null;
        let FEED_TOTAL_COUNT_EL = null;
        let FEED_BULK_DELETE_BUTTON_EL = null;
        let FEED_SELECT_ALL_EL = null;
        let FEED_FILTER_TIMER = null;
        let FEED_BULK_DELETE_IN_PROGRESS = false;
        let FEED_SORT_KEY = 'title';
        let FEED_SORT_DIR = 'asc';
        const FEED_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

        function initFeedUI() {
          FEED_ROWS = Array.from(document.querySelectorAll('.feed-row'));
          FEED_CHECKBOXES = Array.from(document.querySelectorAll('.feed-select'));
          FEED_SELECTED_COUNT_EL = document.getElementById('selected-feed-count');
          FEED_MATCH_COUNT_EL = document.getElementById('feed-match-count');
          FEED_TOTAL_COUNT_EL = document.getElementById('feed-total-count');
          FEED_BULK_DELETE_BUTTON_EL = document.getElementById('bulk-delete-feeds-button');
          FEED_SELECT_ALL_EL = document.getElementById('select-all-feeds');
          setupFeedTableResizing();
          setupFeedTableSorting();
          setupFeedDeleteButtons();
          updateFeedMatchCount();
          updateFeedSelectionState();
        }

        function updateFeedMatchCount() {
          if (!FEED_MATCH_COUNT_EL) return;
          const total = FEED_ROWS.length;
          const visible = FEED_ROWS.filter((row) => !row.hidden).length;
          const query = (document.getElementById('feed-search')?.value || '').trim();
          FEED_MATCH_COUNT_EL.textContent = query ? ('Showing ' + visible + ' of ' + total) : ('Showing ' + total);
        }

        function scheduleFeedFilter() {
          if (FEED_FILTER_TIMER) {
            clearTimeout(FEED_FILTER_TIMER);
          }
          FEED_FILTER_TIMER = setTimeout(filterFeedRows, 120);
        }

        function getSortValue(row, key) {
          const prop = 'sort' + key.charAt(0).toUpperCase() + key.slice(1);
          return (row.dataset && row.dataset[prop]) ? row.dataset[prop] : '';
        }

        function updateFeedSortIndicators(table) {
          const headerCells = Array.from(table.querySelectorAll('th[data-sort-key]'));
          headerCells.forEach((th) => {
            const key = th.getAttribute('data-sort-key') || '';
            const indicator = th.querySelector('.sort-indicator');
            const active = key === FEED_SORT_KEY;

            if (indicator) {
              indicator.textContent = active ? (FEED_SORT_DIR === 'asc' ? '^' : 'v') : '';
            }
            th.setAttribute('aria-sort', active ? (FEED_SORT_DIR === 'asc' ? 'ascending' : 'descending') : 'none');
          });
        }

        function sortFeedTableBy(key) {
          const table = document.querySelector('table.table-feeds');
          const tbody = document.getElementById('feed-table-body');
          if (!table || !tbody) return;

          if (FEED_SORT_KEY === key) {
            FEED_SORT_DIR = FEED_SORT_DIR === 'asc' ? 'desc' : 'asc';
          } else {
            FEED_SORT_KEY = key;
            FEED_SORT_DIR = 'asc';
          }

          const dirMultiplier = FEED_SORT_DIR === 'asc' ? 1 : -1;
          const rows = Array.from(tbody.querySelectorAll('.feed-row'));
          rows.sort((a, b) => {
            const av = getSortValue(a, FEED_SORT_KEY);
            const bv = getSortValue(b, FEED_SORT_KEY);
            return dirMultiplier * FEED_COLLATOR.compare(av, bv);
          });

          const fragment = document.createDocumentFragment();
          rows.forEach((row) => fragment.appendChild(row));
          tbody.appendChild(fragment);

          updateFeedSortIndicators(table);
        }

        function setupFeedTableSorting() {
          const table = document.querySelector('table.table-feeds');
          if (!table) return;

          table.querySelectorAll('button.th-button[data-sort-key]').forEach((button) => {
            button.addEventListener('click', () => {
              const key = button.getAttribute('data-sort-key') || '';
              if (!key) return;
              sortFeedTableBy(key);
            });
          });

          updateFeedSortIndicators(table);
        }

        function setupFeedTableResizing() {
          const table = document.querySelector('table.table-feeds');
          if (!table) return;

          const storageKey = 'email-to-rss.admin.feedsTable.colWidths';
          const minWidths = {
            title: 220,
            feedId: 120,
            email: 160,
            rss: 160,
            actions: 160,
          };
          const defaultWidths = {
            title: 340,
            feedId: 160,
            email: 220,
            rss: 220,
            actions: 200,
          };

          const cols = Array.from(table.querySelectorAll('colgroup col'));
          const colByKey = {};
          cols.forEach((col) => {
            const key = col.getAttribute('data-col');
            if (key) colByKey[key] = col;
          });

          // Restore widths
          try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
            Object.keys(saved || {}).forEach((key) => {
              const px = Number(saved[key]);
              if (!colByKey[key] || !Number.isFinite(px)) return;
              colByKey[key].style.width = px + 'px';
            });
          } catch {
            // Ignore bad localStorage values
          }

          const persist = () => {
            try {
              const out = {};
              Object.keys(colByKey).forEach((key) => {
                if (key === 'select') return;
                const px = parseInt(colByKey[key].style.width || '0', 10);
                if (Number.isFinite(px) && px > 0) out[key] = px;
              });
              localStorage.setItem(storageKey, JSON.stringify(out));
            } catch {
              // localStorage may be unavailable in some modes; ignore
            }
          };

          let active = null;
          let rafId = 0;
          let pendingWidth = 0;

          table.querySelectorAll('.col-resizer').forEach((handle) => {
            handle.addEventListener('pointerdown', (event) => {
              event.preventDefault();
              event.stopPropagation();

              const key = handle.getAttribute('data-col');
              const col = key ? colByKey[key] : null;
              if (!key || !col) return;

              const th = handle.closest('th');
              const startWidth = th ? th.getBoundingClientRect().width : parseInt(col.style.width || '0', 10) || 120;

              active = { key, col, startX: event.clientX, startWidth };
              document.body.classList.add('is-resizing');
              handle.setPointerCapture(event.pointerId);
            });

            handle.addEventListener('pointermove', (event) => {
              if (!active) return;
              const minPx = minWidths[active.key] || 120;
              const nextWidth = Math.max(minPx, Math.round(active.startWidth + (event.clientX - active.startX)));
              pendingWidth = nextWidth;
              if (rafId) return;
              rafId = requestAnimationFrame(() => {
                active.col.style.width = pendingWidth + 'px';
                rafId = 0;
              });
            });

            const finish = () => {
              if (!active) return;
              active = null;
              document.body.classList.remove('is-resizing');
              persist();
            };
            handle.addEventListener('pointerup', finish);
            handle.addEventListener('pointercancel', finish);

            handle.addEventListener('dblclick', (event) => {
              event.preventDefault();
              event.stopPropagation();
              const key = handle.getAttribute('data-col');
              const col = key ? colByKey[key] : null;
              const px = key ? defaultWidths[key] : null;
              if (!key || !col || !px) return;
              col.style.width = px + 'px';
              persist();
            });
          });
        }

        const DELETE_CONFIRM_LABEL = 'Confirm delete';
        const DELETE_LOADING_LABEL = 'Deleting...';
        const DELETE_CONFIRM_TIMEOUT_MS = 4000;

        function getDeleteView() {
          return new URL(window.location.href).searchParams.get('view') || 'list';
        }

        function resetDeleteButton(buttonEl) {
          if (!buttonEl) return;
          buttonEl.classList.remove('is-confirming');
          buttonEl.removeAttribute('data-confirming');
          buttonEl.disabled = false;
          const original = buttonEl.dataset.originalLabel || (buttonEl.textContent || '').trim() || 'Delete';
          buttonEl.innerHTML = original;
        }

        function animateRowRemoval(row, onDone) {
          if (!row) {
            if (onDone) onDone();
            return;
          }

          const isListItem = row.tagName.toLowerCase() === 'li';
          if (isListItem) {
            row.style.maxHeight = row.getBoundingClientRect().height + 'px';
            row.style.overflow = 'hidden';
          }

          row.classList.add('is-removing');

          requestAnimationFrame(() => {
            if (isListItem) {
              row.style.maxHeight = '0px';
              row.style.marginTop = '0px';
              row.style.marginBottom = '0px';
              row.style.paddingTop = '0px';
              row.style.paddingBottom = '0px';
            }
          });

          window.setTimeout(() => {
            row.remove();
            if (onDone) onDone();
          }, 240);
        }

        async function deleteFeedRequest(feedId, view) {
          const res = await fetch('/admin/feeds/' + encodeURIComponent(feedId) + '/delete?view=' + encodeURIComponent(view), {
            method: 'POST',
            headers: {
              'Accept': 'application/json',
            },
            credentials: 'same-origin',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) {
            const message = data && data.error ? String(data.error) : ('Request failed (' + res.status + ')');
            throw new Error(message);
          }
          return data;
        }

        function refreshFeedRowCache() {
          FEED_ROWS = Array.from(document.querySelectorAll('.feed-row'));
          FEED_CHECKBOXES = Array.from(document.querySelectorAll('.feed-select'));
          if (FEED_TOTAL_COUNT_EL) {
            FEED_TOTAL_COUNT_EL.textContent = String(FEED_ROWS.length);
          }
          updateFeedMatchCount();
          updateFeedSelectionState();
        }

        function setupFeedDeleteButtons() {
          const buttons = Array.from(document.querySelectorAll('button[data-delete-kind="feed"]'));
          buttons.forEach((button) => {
            if (button.dataset.deleteReady === 'true') return;
            button.dataset.deleteReady = 'true';
            const original = (button.textContent || '').trim() || 'Delete';
            button.dataset.originalLabel = original;

            let confirming = false;
            let confirmTimer = 0;
            let inFlight = false;

            const startConfirm = () => {
              confirming = true;
              button.classList.add('is-confirming');
              button.setAttribute('data-confirming', 'true');
              button.innerHTML = DELETE_CONFIRM_LABEL;
              if (confirmTimer) window.clearTimeout(confirmTimer);
              confirmTimer = window.setTimeout(() => {
                confirming = false;
                resetDeleteButton(button);
              }, DELETE_CONFIRM_TIMEOUT_MS);
            };

            button.addEventListener('click', async (event) => {
              event.preventDefault();
              if (inFlight) return;

              if (!confirming) {
                startConfirm();
                return;
              }

              if (confirmTimer) window.clearTimeout(confirmTimer);
              inFlight = true;
              setButtonLoading(button, true, DELETE_LOADING_LABEL);

              const toast = window.showToast
                ? window.showToast('Deleting feed...', { type: 'info', loading: true, duration: 0 })
                : null;

              const feedId = button.getAttribute('data-feed-id') || '';
              const view = button.getAttribute('data-view') || getDeleteView();
              const row = button.closest('.feed-row');

              try {
                await deleteFeedRequest(feedId, view);

                if (toast && toast.update) {
                  toast.update('Feed deleted.', { type: 'success', loading: false, duration: 3200 });
                } else if (window.showToast) {
                  window.showToast('Feed deleted.', { type: 'success' });
                }

                animateRowRemoval(row, () => {
                  refreshFeedRowCache();
                });
              } catch (error) {
                if (toast && toast.update) {
                  toast.update('Delete failed: ' + (error && error.message ? error.message : 'Unknown error'), { type: 'error', loading: false });
                } else if (window.showToast) {
                  window.showToast('Delete failed: ' + (error && error.message ? error.message : 'Unknown error'), { type: 'error' });
                }
                setButtonLoading(button, false);
                confirming = false;
                resetDeleteButton(button);
              } finally {
                inFlight = false;
                if (!row) {
                  setButtonLoading(button, false);
                  confirming = false;
                  resetDeleteButton(button);
                }
              }
            });

            button.addEventListener('keydown', (event) => {
              if (event.key === 'Escape' && confirming && !inFlight) {
                confirming = false;
                if (confirmTimer) window.clearTimeout(confirmTimer);
                resetDeleteButton(button);
              }
            });
          });
        }

        function updateFeedSelectionState() {
          if (!FEED_CHECKBOXES.length) {
            return;
          }

          const selected = FEED_CHECKBOXES.filter((checkbox) => checkbox.checked);

          if (FEED_SELECTED_COUNT_EL) {
            FEED_SELECTED_COUNT_EL.textContent = selected.length + ' selected';
          }
          if (FEED_BULK_DELETE_BUTTON_EL) {
            FEED_BULK_DELETE_BUTTON_EL.disabled = selected.length === 0;
          }
          if (FEED_SELECT_ALL_EL) {
            const visibleCheckboxes = FEED_CHECKBOXES.filter((checkbox) => !(checkbox.closest('tr')?.hidden));
            FEED_SELECT_ALL_EL.checked = visibleCheckboxes.length > 0 && visibleCheckboxes.every((checkbox) => checkbox.checked);
          }
        }

        function toggleAllFeeds(checked) {
          FEED_CHECKBOXES.forEach((checkbox) => {
            if (!checkbox.closest('tr')?.hidden) {
              checkbox.checked = checked;
            }
          })
          updateFeedSelectionState();
        }

        function setVisibleFeedSelection(checked) {
          FEED_CHECKBOXES.forEach((checkbox) => {
            if (!checkbox.closest('tr')?.hidden) {
              checkbox.checked = checked;
            }
          })
          updateFeedSelectionState();
        }

        function selectMatchingFeeds() {
          setVisibleFeedSelection(true);
        }

        function clearFeedSelection() {
          FEED_CHECKBOXES.forEach((checkbox) => {
            checkbox.checked = false;
          })
          updateFeedSelectionState();
        }

        function filterFeedRows() {
          const query = (document.getElementById('feed-search')?.value || '').toLowerCase().trim();
          FEED_ROWS.forEach((row) => {
            const haystack = row.getAttribute('data-search') || '';
            row.hidden = !!query && !haystack.includes(query);
          });
          updateFeedMatchCount();
          updateFeedSelectionState();
        }

        function confirmBulkFeedDelete() {
          const selected = FEED_CHECKBOXES.filter((checkbox) => checkbox.checked).length;
          if (selected === 0) return false;

          const query = (document.getElementById('feed-search')?.value || '').trim();
          const extra =
            selected >= 50 && !query
              ? '\\n\\nThis is a large delete. Tip: use Search to narrow down spam first.'
              : '';
          return confirm(
            'Delete ' +
              selected +
              ' selected feed(s)? This disables the feeds immediately. Stored emails are cleaned up best-effort and may take a while.' +
              extra,
          );
        }

        function setButtonLoading(buttonEl, loading, label) {
          if (!buttonEl) return;
          if (loading) {
            if (!buttonEl.dataset.originalLabel) {
              buttonEl.dataset.originalLabel = (buttonEl.textContent || '').trim();
            }
            const text = label || 'Working...';
            buttonEl.classList.add('is-loading');
            buttonEl.disabled = true;
            buttonEl.innerHTML = '<span class="spinner" aria-hidden="true"></span>' + text;
            return;
          }

          const original = buttonEl.dataset.originalLabel || (buttonEl.textContent || '').trim();
          buttonEl.classList.remove('is-loading');
          buttonEl.innerHTML = original;
        }

        function removeFeedRowsById(feedIds) {
          const toRemove = new Set((feedIds || []).map((v) => String(v)));
          if (toRemove.size === 0) return;

          FEED_ROWS.forEach((row) => {
            const checkbox = row.querySelector('input.feed-select');
            const id = checkbox ? checkbox.value : '';
            if (toRemove.has(id)) {
              row.remove();
            }
          });

          FEED_ROWS = Array.from(document.querySelectorAll('.feed-row'));
          FEED_CHECKBOXES = Array.from(document.querySelectorAll('.feed-select'));

          if (FEED_TOTAL_COUNT_EL) {
            FEED_TOTAL_COUNT_EL.textContent = String(FEED_ROWS.length);
          }
        }

        function onBulkFeedDeleteSubmit(event) {
          if (event && event.preventDefault) event.preventDefault();
          void bulkDeleteSelectedFeeds();
          return false;
        }

        async function bulkDeleteSelectedFeeds() {
          if (FEED_BULK_DELETE_IN_PROGRESS) return;
          const selectedIds = FEED_CHECKBOXES.filter((checkbox) => checkbox.checked).map((checkbox) => checkbox.value);
          if (selectedIds.length === 0) {
            if (window.showToast) window.showToast('No feeds selected.', { type: 'info' });
            return;
          }
          if (!confirmBulkFeedDelete()) {
            return;
          }

          FEED_BULK_DELETE_IN_PROGRESS = true;
          setButtonLoading(FEED_BULK_DELETE_BUTTON_EL, true, 'Deleting...');

          const toast = window.showToast
            ? window.showToast('Deleting ' + selectedIds.length + ' feed(s)...', { type: 'info', loading: true, duration: 0 })
            : null;

          const batchSize = 10;
          let deletedTotal = 0;
          const failed = [];

          try {
            for (let i = 0; i < selectedIds.length; i += batchSize) {
              const batch = selectedIds.slice(i, i + batchSize);
              const res = await fetch('/admin/feeds/bulk-delete', {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'Accept': 'application/json',
                },
                credentials: 'same-origin',
                body: JSON.stringify({ feedIds: batch }),
              });

              let data = {};
              if (window.parseJsonResponseOrThrow) {
                data = await window.parseJsonResponseOrThrow(res, { prefix: 'Bulk feed delete failed' });
              } else {
                data = await res.json().catch(() => ({}));
                if (!res.ok) {
                  const message = data && data.error ? String(data.error) : ('Bulk feed delete failed (HTTP ' + res.status + ')');
                  throw new Error(message);
                }
              }

              const deletedIds = Array.isArray(data.deletedFeedIds) ? data.deletedFeedIds : batch;
              const failedIds = Array.isArray(data.failedFeedIds) ? data.failedFeedIds : [];
              const failureDetails = Array.isArray(data.failures) ? data.failures : [];

              removeFeedRowsById(deletedIds);
              deletedTotal += deletedIds.length;

              if (toast && toast.update) {
                const done = Math.min(i + batch.length, selectedIds.length);
                toast.update('Deleting... (' + done + ' of ' + selectedIds.length + ')', { type: 'info' });
              }

              // Keep selection state consistent as rows disappear.
              updateFeedMatchCount();
              updateFeedSelectionState();

              // If a batch fails for some feeds, retry those one-by-one using the bulk-delete
              // endpoint with a single id (keeps semantics consistent and avoids hiding active feeds).
              if (failedIds.length > 0) {
                if (toast && toast.update) {
                  toast.update('Retrying ' + failedIds.length + ' failed feed(s) one-by-one...', { type: 'info' });
                }

                const stillFailed = [];
                for (let j = 0; j < failedIds.length; j++) {
                  const feedId = String(failedIds[j] || '');
                  if (!feedId) continue;
                  try {
                    const retryRes = await fetch('/admin/feeds/bulk-delete', {
                      method: 'POST',
                      headers: {
                        'Content-Type': 'application/json',
                        'Accept': 'application/json',
                      },
                      credentials: 'same-origin',
                      body: JSON.stringify({ feedIds: [feedId] }),
                    });

                    let retryData = {};
                    if (window.parseJsonResponseOrThrow) {
                      retryData = await window.parseJsonResponseOrThrow(retryRes, { prefix: 'Retry delete failed' });
                    } else {
                      retryData = await retryRes.json().catch(() => ({}));
                      if (!retryRes.ok) {
                        const message = retryData && retryData.error ? String(retryData.error) : ('Retry delete failed (HTTP ' + retryRes.status + ')');
                        throw new Error(message);
                      }
                    }

                    const retryDeleted = Array.isArray(retryData.deletedFeedIds) ? retryData.deletedFeedIds : [];
                    const retryFailed = Array.isArray(retryData.failedFeedIds) ? retryData.failedFeedIds : [];

                    if (retryDeleted.includes(feedId)) {
                      removeFeedRowsById([feedId]);
                      deletedTotal += 1;
                    } else if (retryFailed.includes(feedId)) {
                      stillFailed.push(feedId);
                    } else {
                      stillFailed.push(feedId);
                    }
                  } catch (e) {
                    stillFailed.push(feedId);
                  }

                  if (toast && toast.update) {
                    toast.update('Retrying... (' + (j + 1) + ' of ' + failedIds.length + ')', { type: 'info' });
                  }
                }

                // Replace failed ids from this batch with only the ones that still failed after retry.
                if (stillFailed.length > 0) {
                  failed.push(...stillFailed);
                  if (window.showToast && failureDetails.length > 0) {
                    const first = failureDetails[0] && failureDetails[0].error ? String(failureDetails[0].error) : '';
                    if (first) {
                      window.showToast('Some feeds failed to delete: ' + first, { type: 'error' });
                    }
                  }
                }

                updateFeedMatchCount();
                updateFeedSelectionState();
              }
            }

            if (toast && toast.dismiss) toast.dismiss();
            const uniqueFailed = Array.from(new Set(failed.map((v) => String(v)).filter(Boolean)));
            if (uniqueFailed.length > 0) {
              if (window.showToast) {
                window.showToast(
                  'Deleted ' + deletedTotal + ' feed(s). ' + uniqueFailed.length + ' failed (still visible).',
                  { type: 'error' },
                );
              }
            } else {
              if (window.showToast) window.showToast('Deleted ' + deletedTotal + ' feed(s).', { type: 'success' });
            }
          } catch (error) {
            if (toast && toast.dismiss) toast.dismiss();
            if (window.showToast) {
              window.showToast((error && error.message) ? error.message : 'Bulk feed delete failed.', { type: 'error' });
            }
          } finally {
            FEED_BULK_DELETE_IN_PROGRESS = false;
            setButtonLoading(FEED_BULK_DELETE_BUTTON_EL, false);
            updateFeedSelectionState();
          }
        }

        document.addEventListener('DOMContentLoaded', () => {
          initFeedUI();
        });
`;

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
