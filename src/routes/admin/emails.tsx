import { Hono } from "hono";
import {
  Env,
  FeedConfig,
  FeedMetadata,
  EmailData,
  EmailMetadata,
} from "../../types";
import { logger } from "../../lib/logger";
import { Layout, clampText } from "./ui";
import { deleteKeysWithConcurrency } from "./helpers";
import { feedRssUrl, feedAtomUrl, feedEmailAddress } from "../../utils/urls";
import { emailsPageScript } from "../../scripts/generated/emails-page";

type AppEnv = { Bindings: Env };

export const emailsRouter = new Hono<AppEnv>();

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

type CopyFieldProps = {
  label: string;
  value: string;
  display?: string;
};

const CopyField = ({ label, value, display }: CopyFieldProps) => (
  <div class="copyable">
    <span class="copyable-label">{label}</span>
    <div class="copyable-content">
      <span class="copyable-value" data-copy={value}>
        {display ?? value}
      </span>
      <div class="copy-icon-container">
        <CopyIcon />
        <CheckIcon />
      </div>
    </div>
  </div>
);

function extractSenderEmail(from: string): string {
  const match = from.match(/<([^>]+@[^>]+)>/);
  return match ? match[1].trim().toLowerCase() : from.trim().toLowerCase();
}

type SenderFieldProps = {
  from: string;
  feedId: string;
};

const SenderField = ({ from, feedId }: SenderFieldProps) => {
  const senderEmail = extractSenderEmail(from);
  const senderDomain = senderEmail.split("@")[1] || "";

  return (
    <div class="copyable">
      <span class="copyable-label">From:</span>
      <div class="copyable-content">
        <span class="copyable-value" data-copy={from}>
          {from}
        </span>
        <div class="copy-icon-container">
          <CopyIcon />
          <CheckIcon />
        </div>
      </div>
      <div
        class="sender-filter-dropdown"
        data-feed-id={feedId}
        data-email={senderEmail}
        data-domain={senderDomain}
      >
        <button
          type="button"
          class="sender-filter-btn"
          aria-label="Sender filter options"
          onclick="toggleSenderFilter(this)"
        >
          ⋮
        </button>
        <div class="sender-filter-menu" role="menu">
          <button
            type="button"
            class="sender-filter-item sender-filter-allow"
            data-action="allow_sender"
          >
            Allow {senderEmail}
          </button>
          <button
            type="button"
            class="sender-filter-item sender-filter-allow"
            data-action="allow_domain"
          >
            Allow @{senderDomain}
          </button>
          <button
            type="button"
            class="sender-filter-item sender-filter-block"
            data-action="block_sender"
          >
            Block {senderEmail}
          </button>
          <button
            type="button"
            class="sender-filter-item sender-filter-block"
            data-action="block_domain"
          >
            Block @{senderDomain}
          </button>
        </div>
        <span class="sender-filter-feedback" aria-live="polite"></span>
      </div>
    </div>
  );
};

// ── View all emails for a feed ────────────────────────────────────────────────

emailsRouter.get("/feeds/:feedId/emails", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");
  const message = c.req.query("message");
  const count = Number(c.req.query("count") || "0");

  const feedConfig = (await emailStorage.get(`feed:${feedId}:config`, {
    type: "json",
  })) as FeedConfig | null;
  const feedMetadata = (await emailStorage.get(`feed:${feedId}:metadata`, {
    type: "json",
  })) as FeedMetadata | null;

  if (!feedConfig || !feedMetadata) {
    return c.text("Feed not found", 404);
  }

  const emailAddress = feedEmailAddress(feedId, env);
  const rssUrl = feedRssUrl(feedId, env);
  const atomUrl = feedAtomUrl(feedId, env);

  return c.html(
    <Layout title={`${feedConfig.title} - Emails`}>
      <div class="container container-wide fade-in">
        <div class="header-with-actions">
          <div class="header-title">
            <h1>{feedConfig.title} - Emails</h1>
          </div>
          <div class="header-actions">
            <a href="/admin" class="button button-secondary button-back">
              Back to Dashboard
            </a>
          </div>
        </div>

        <div class="card">
          <h2>Feed Details</h2>
          <div>
            <CopyField label="Email Address:" value={emailAddress} />
            <CopyField label="RSS Feed:" value={rssUrl} />
            <CopyField label="Atom Feed:" value={atomUrl} />
          </div>
          <div class="feed-validate">
            <a
              href={`https://validator.w3.org/feed/check.cgi?url=${encodeURIComponent(atomUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="https://validator.w3.org/feed/images/valid-atom.png"
                alt="[Valid Atom 1.0]"
                title="Validate my Atom 1.0 feed"
              />
            </a>
            <a
              href={`https://validator.w3.org/feed/check.cgi?url=${encodeURIComponent(rssUrl)}`}
              target="_blank"
              rel="noopener noreferrer"
            >
              <img
                src="https://validator.w3.org/feed/images/valid-rss-rogers.png"
                alt="[Valid RSS]"
                title="Validate my RSS feed"
              />
            </a>
          </div>
        </div>

        <h2>
          Emails (
          <span id="email-total-count">{feedMetadata.emails.length}</span>)
        </h2>

        {message === "bulkDeleted" && (
          <div class="card">
            <p>Deleted {Number.isFinite(count) ? count : 0} email(s).</p>
          </div>
        )}
        {message === "bulkDeleteNoop" && (
          <div class="card">
            <p>No emails were selected.</p>
          </div>
        )}
        {feedMetadata.emails.length > 0 ? (
          <form
            action={`/admin/feeds/${feedId}/emails/bulk-delete`}
            method="post"
            onsubmit="return onBulkEmailDeleteSubmit(event)"
          >
            <div class="toolbar">
              <div class="toolbar-group toolbar-group-fill">
                <input
                  type="search"
                  id="email-search"
                  class="search"
                  placeholder="Search email subjects"
                  oninput="scheduleEmailFilter()"
                />
                <span class="pill" id="email-match-count">
                  Showing {feedMetadata.emails.length}
                </span>
                <span class="pill" id="selected-email-count">
                  0 selected
                </span>
                <button
                  type="button"
                  class="button button-small button-secondary"
                  onclick="selectMatchingEmails()"
                >
                  Select Results
                </button>
                <button
                  type="button"
                  class="button button-small button-secondary"
                  onclick="clearEmailSelection()"
                >
                  Clear Selection
                </button>
                <button
                  id="bulk-delete-emails-button"
                  type="submit"
                  class="button button-small button-danger"
                  disabled
                >
                  Delete Selected
                </button>
              </div>
            </div>

            <div class="table-wrap">
              <table class="table table-emails">
                <colgroup>
                  <col data-col="select" style="width: 44px;" />
                  <col data-col="subject" style="width: 520px;" />
                  <col data-col="receivedAt" style="width: 220px;" />
                  <col data-col="actions" style="width: 200px;" />
                </colgroup>
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        id="select-all-emails"
                        onchange="toggleAllEmails(this.checked)"
                      />
                    </th>
                    <th
                      class="th-resizable"
                      data-sort-key="subject"
                      aria-sort="none"
                    >
                      <button
                        type="button"
                        class="th-button"
                        data-sort-key="subject"
                      >
                        Subject
                        <span class="sort-indicator" aria-hidden="true"></span>
                      </button>
                      <div
                        class="col-resizer"
                        data-col="subject"
                        title="Resize"
                      ></div>
                    </th>
                    <th
                      class="th-resizable"
                      data-sort-key="receivedAt"
                      aria-sort="none"
                    >
                      <button
                        type="button"
                        class="th-button"
                        data-sort-key="receivedAt"
                      >
                        Received
                        <span class="sort-indicator" aria-hidden="true"></span>
                      </button>
                      <div
                        class="col-resizer"
                        data-col="receivedAt"
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
                <tbody>
                  {feedMetadata.emails.map((email: EmailMetadata) => {
                    const subjectDisplay = clampText(email.subject, 180);
                    const subjectHover = clampText(email.subject, 1000);
                    const attachmentCount = email.attachmentIds?.length ?? 0;
                    const attachmentLabel = `${attachmentCount} attachment${
                      attachmentCount > 1 ? "s" : ""
                    }`;
                    const sortSubject = subjectHover.toLowerCase();
                    const sortReceivedAt = String(email.receivedAt);
                    const searchHaystack = clampText(
                      email.subject,
                      320,
                    ).toLowerCase();
                    return (
                      <tr
                        class="email-row"
                        data-email-key={email.key}
                        data-search={searchHaystack}
                        data-sort-subject={sortSubject}
                        data-sort-received-at={sortReceivedAt}
                      >
                        <td>
                          <input
                            type="checkbox"
                            class="email-select"
                            name="emailKeys"
                            value={email.key}
                            onchange="updateEmailSelectionState()"
                          />
                        </td>
                        <td>
                          <div class="subject-cell">
                            {attachmentCount > 0 ? (
                              <span
                                class="attachment-indicator"
                                title={attachmentLabel}
                                aria-label={attachmentLabel}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  stroke-width="2"
                                  stroke-linecap="round"
                                  stroke-linejoin="round"
                                  aria-hidden="true"
                                >
                                  <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
                                </svg>
                              </span>
                            ) : null}
                            <span class="truncate" title={subjectHover}>
                              {subjectDisplay}
                            </span>
                          </div>
                        </td>
                        <td>{new Date(email.receivedAt).toLocaleString()}</td>
                        <td>
                          <div class="row-actions">
                            <a
                              href={`/admin/emails/${email.key}`}
                              class="button button-small"
                            >
                              View
                            </a>
                            <button
                              type="button"
                              class="button button-small button-danger button-delete"
                              data-delete-kind="email"
                              data-email-key={email.key}
                              data-feed-id={feedId}
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
        ) : (
          <div class="card">
            <p>
              No emails received yet. Subscribe to newsletters using the email
              address above.
            </p>
          </div>
        )}
      </div>

      {/* Config bootstrap — injects dynamic server-side data before the static compiled script */}
      <script
        dangerouslySetInnerHTML={{
          __html: `window.__APP_CONFIG__=${JSON.stringify({ feedId })}`,
        }}
      />
      {/* Emails page logic compiled from src/scripts/client/emails-page.ts */}
      <script dangerouslySetInnerHTML={{ __html: emailsPageScript }} />
    </Layout>,
  );
});

// ── View single email ─────────────────────────────────────────────────────────

emailsRouter.get("/emails/:emailKey", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const emailKey = c.req.param("emailKey");

  const emailData = (await emailStorage.get(emailKey, {
    type: "json",
  })) as EmailData | null;

  if (!emailData) return c.text("Email not found", 404);

  const feedId = emailKey.split(":")[1];

  const htmlContent = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><style>body{font-family:-apple-system,BlinkMacSystemFont,'SF Pro Text','SF Pro Display','Helvetica Neue',Arial,sans-serif;line-height:1.5;padding:16px;margin:0;color:#333;box-sizing:border-box}img{max-width:100%;height:auto}a{color:#0070f3}@media(prefers-color-scheme:dark){body{background-color:#1c1c1e;color:#ffffff}a{color:#0a84ff}}</style></head><body>${emailData.content}</body></html>`;

  const encodedHtmlContent = (() => {
    const encoder = new TextEncoder();
    const bytes = encoder.encode(htmlContent);
    return btoa(String.fromCharCode(...new Uint8Array(bytes)));
  })();

  const rawHtml = emailData.content.replace(/</g, "&lt;").replace(/>/g, "&gt;");

  const viewScript = `
        function showRendered() {
          document.getElementById('rendered-view').style.display = 'block';
          document.getElementById('raw-view').style.display = 'none';
          document.getElementById('rendered-button').classList.add('active');
          document.getElementById('raw-button').classList.remove('active');
        }
        function showRaw() {
          document.getElementById('rendered-view').style.display = 'none';
          document.getElementById('raw-view').style.display = 'block';
          document.getElementById('rendered-button').classList.remove('active');
          document.getElementById('raw-button').classList.add('active');
        }
        window.addEventListener('load', function() {
          const iframe = document.querySelector('.email-iframe');
          if (!iframe) return;
          iframe.style.height = '500px';
          try {
            iframe.onload = function() {
              const doc = iframe.contentDocument || iframe.contentWindow.document;
              if (doc) iframe.style.height = Math.min(800, Math.max(500, doc.body.scrollHeight)) + 'px';
            };
          } catch (e) { /* cross-origin */ }
        });
        function toggleSenderFilter(btn) {
          var dropdown = btn.closest('.sender-filter-dropdown');
          var isOpen = dropdown.hasAttribute('data-open');
          document.querySelectorAll('.sender-filter-dropdown[data-open]').forEach(function(d) {
            d.removeAttribute('data-open');
          });
          if (!isOpen) dropdown.setAttribute('data-open', '');
        }
        function showSenderFeedback(feedback, ok, msg) {
          feedback.textContent = msg;
          feedback.className = 'sender-filter-feedback ' + (ok ? 'sender-filter-feedback-ok' : 'sender-filter-feedback-error');
          setTimeout(function() {
            feedback.textContent = '';
            feedback.className = 'sender-filter-feedback';
          }, 3000);
        }
        document.addEventListener('click', function(e) {
          var item = e.target.closest('.sender-filter-item');
          if (item) {
            var dropdown = item.closest('.sender-filter-dropdown');
            var action = item.dataset.action;
            var value = (action === 'allow_sender' || action === 'block_sender')
              ? dropdown.dataset.email
              : dropdown.dataset.domain;
            dropdown.removeAttribute('data-open');
            var feedback = dropdown.querySelector('.sender-filter-feedback');
            fetch('/admin/feeds/' + dropdown.dataset.feedId + '/sender-filter', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: action, value: value })
            }).then(function(res) {
              return res.json();
            }).then(function(data) {
              showSenderFeedback(feedback, data.ok, data.ok ? 'Saved' : (data.error || 'Error'));
            }).catch(function() {
              showSenderFeedback(feedback, false, 'Network error');
            });
            return;
          }
          if (!e.target.closest('.sender-filter-dropdown')) {
            document.querySelectorAll('.sender-filter-dropdown[data-open]').forEach(function(d) {
              d.removeAttribute('data-open');
            });
          }
        });
      `;

  return c.html(
    <Layout title={`Email: ${emailData.subject}`}>
      <div class="container fade-in">
        <div class="header-with-actions">
          <div class="header-title">
            <h1>Email Content</h1>
          </div>
          <div class="header-actions">
            <a
              href={`/admin/feeds/${feedId}/emails`}
              class="button button-secondary button-back"
            >
              Back to Emails
            </a>
          </div>
        </div>

        <div class="card">
          <div class="email-meta">
            <div class="email-metadata-grid">
              <CopyField label="Subject:" value={emailData.subject} />
              <CopyField
                label="Received:"
                value={new Date(emailData.receivedAt).toLocaleString()}
              />
              <SenderField from={emailData.from} feedId={feedId} />
              <CopyField label="To:" value={feedEmailAddress(feedId, env)} />
            </div>
          </div>

          <div class="toggle-view">
            <button
              id="rendered-button"
              class="toggle-button active"
              onclick="showRendered()"
            >
              Rendered View
            </button>
            <button id="raw-button" class="toggle-button" onclick="showRaw()">
              Raw HTML
            </button>
          </div>

          <div class="email-content">
            <div id="rendered-view" class="email-iframe-container">
              <iframe
                class="email-iframe"
                src={`data:text/html;base64,${encodedHtmlContent}`}
              ></iframe>
            </div>
            <div id="raw-view" class="email-raw" style="display: none;">
              <pre dangerouslySetInnerHTML={{ __html: rawHtml }}></pre>
            </div>
          </div>
        </div>
      </div>

      <script dangerouslySetInnerHTML={{ __html: viewScript }} />
    </Layout>,
  );
});

// ── Delete single email ───────────────────────────────────────────────────────

emailsRouter.post("/emails/:emailKey/delete", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const emailKey = c.req.param("emailKey");
  const wantsJson = (c.req.header("Accept") || "").includes("application/json");

  try {
    const feedId = c.req.query("feedId");
    if (!feedId) {
      if (wantsJson)
        return c.json({ ok: false, error: "Feed ID is required" }, 400);
      return c.text("Feed ID is required", 400);
    }

    const feedMetadataKey = `feed:${feedId}:metadata`;
    const feedMetadata = (await emailStorage.get(feedMetadataKey, {
      type: "json",
    })) as FeedMetadata | null;
    const attachmentIds =
      feedMetadata?.emails.find((e) => e.key === emailKey)?.attachmentIds ?? [];

    await emailStorage.delete(emailKey);

    if (feedMetadata) {
      feedMetadata.emails = feedMetadata.emails.filter(
        (email) => email.key !== emailKey,
      );
      await emailStorage.put(feedMetadataKey, JSON.stringify(feedMetadata));
    }

    if (env.ATTACHMENT_BUCKET && attachmentIds.length > 0) {
      await Promise.allSettled(
        attachmentIds.map((id) => env.ATTACHMENT_BUCKET!.delete(id)),
      );
    }

    if (wantsJson) return c.json({ ok: true, emailKey, feedId });
    return c.redirect(`/admin/feeds/${feedId}/emails`);
  } catch (error) {
    logger.error("Error deleting email", { emailKey, error: String(error) });
    if (wantsJson)
      return c.json(
        { ok: false, error: "Error deleting email. Please try again." },
        400,
      );
    return c.text("Error deleting email. Please try again.", 400);
  }
});

// ── Bulk delete emails ────────────────────────────────────────────────────────

emailsRouter.post("/feeds/:feedId/emails/bulk-delete", async (c) => {
  const env = c.env;
  const emailStorage = env.EMAIL_STORAGE;
  const feedId = c.req.param("feedId");
  const contentType = c.req.header("Content-Type") || "";
  const wantsJson =
    contentType.includes("application/json") ||
    (c.req.header("Accept") || "").includes("application/json");

  try {
    const feedMetadataKey = `feed:${feedId}:metadata`;
    const feedMetadata = (await emailStorage.get(feedMetadataKey, {
      type: "json",
    })) as FeedMetadata | null;

    if (!feedMetadata) {
      return wantsJson
        ? c.json({ ok: false, error: "Feed not found" }, 404)
        : c.text("Feed not found", 404);
    }

    const allowedKeys = new Set(feedMetadata.emails.map((email) => email.key));

    if (wantsJson) {
      const body = (await c.req.json().catch(() => null)) as {
        emailKeys?: unknown;
      } | null;
      const rawEmailKeys = Array.isArray(body?.emailKeys)
        ? body?.emailKeys
        : [];
      const emailKeys = Array.from(
        new Set(rawEmailKeys.map((value) => String(value)).filter(Boolean)),
      );

      if (emailKeys.length === 0)
        return c.json({ ok: false, error: "No emails were selected." }, 400);
      if (emailKeys.length > 250) {
        return c.json(
          {
            ok: false,
            error:
              "Too many emailKeys for a single request. Please delete in smaller batches.",
          },
          413,
        );
      }

      const candidates = emailKeys.filter((key) => allowedKeys.has(key));
      const candidateSet = new Set(candidates);
      const r2AttachmentIds = feedMetadata.emails
        .filter((e) => candidateSet.has(e.key))
        .flatMap((e) => e.attachmentIds ?? []);

      const { ok: deletedOk, failed: failedEmailKeys } =
        await deleteKeysWithConcurrency(emailStorage, candidates, 35);

      const deletedSet = new Set(deletedOk);
      feedMetadata.emails = feedMetadata.emails.filter(
        (email) => !deletedSet.has(email.key),
      );
      await emailStorage.put(feedMetadataKey, JSON.stringify(feedMetadata));

      if (env.ATTACHMENT_BUCKET && r2AttachmentIds.length > 0) {
        await Promise.allSettled(
          r2AttachmentIds.map((id) => env.ATTACHMENT_BUCKET!.delete(id)),
        );
      }

      return c.json({
        ok: failedEmailKeys.length === 0,
        deletedEmailKeys: deletedOk,
        failedEmailKeys,
      });
    }

    const formData = await c.req.formData();
    const rawEmailKeys = formData
      .getAll("emailKeys")
      .map((value) => value.toString());
    const emailKeys = Array.from(new Set(rawEmailKeys.filter(Boolean)));

    if (emailKeys.length === 0)
      return c.redirect(`/admin/feeds/${feedId}/emails?message=bulkDeleteNoop`);

    const candidates = emailKeys.filter((key) => allowedKeys.has(key));
    const { ok: deletedOk } = await deleteKeysWithConcurrency(
      emailStorage,
      candidates,
      35,
    );

    const deletedSet = new Set(deletedOk);
    feedMetadata.emails = feedMetadata.emails.filter(
      (email) => !deletedSet.has(email.key),
    );
    await emailStorage.put(feedMetadataKey, JSON.stringify(feedMetadata));

    return c.redirect(
      `/admin/feeds/${feedId}/emails?message=bulkDeleted&count=${deletedOk.length}`,
    );
  } catch (error) {
    logger.error("Error bulk deleting emails", {
      feedId,
      error: String(error),
    });
    return wantsJson
      ? c.json(
          {
            ok: false,
            error:
              "Server error while deleting emails. This can happen if Cloudflare is rate-limiting requests or if the Worker hit a plan quota. Please try again.",
          },
          500,
        )
      : c.text("Error bulk deleting emails. Please try again.", 500);
  }
});
