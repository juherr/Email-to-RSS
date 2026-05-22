import { Hono } from "hono";
import { html, raw } from "hono/html";
import {
  Env,
  FeedConfig,
  FeedMetadata,
  EmailData,
  EmailMetadata,
} from "../../types";
import { logger } from "../../lib/logger";
import { layout, clampText } from "./ui";
import { deleteKeysWithConcurrency } from "./helpers";

type AppEnv = { Bindings: Env };

export const emailsRouter = new Hono<AppEnv>();

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

  return c.html(
    layout(
      `${feedConfig.title} - Emails`,
      html`
        <div class="container container-wide fade-in">
          <div class="header-with-actions">
            <div class="header-title">
              <h1>${feedConfig.title} - Emails</h1>
            </div>
            <div class="header-actions">
              <a href="/admin" class="button button-secondary button-back"
                >Back to Dashboard</a
              >
            </div>
          </div>

          <div class="card">
            <h2>Feed Details</h2>
            <div>
              <div class="copyable">
                <span class="copyable-label">Email Address:</span>
                <div class="copyable-content">
                  <span
                    class="copyable-value"
                    data-copy="${feedId}@${env.DOMAIN}"
                    >${feedId}@${env.DOMAIN}</span
                  >
                  <div class="copy-icon-container">
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
                      <rect
                        x="9"
                        y="9"
                        width="13"
                        height="13"
                        rx="2"
                        ry="2"
                      ></rect>
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      ></path>
                    </svg>
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
                  </div>
                </div>
              </div>
              <div class="copyable">
                <span class="copyable-label">RSS Feed:</span>
                <div class="copyable-content">
                  <span
                    class="copyable-value"
                    data-copy="https://${env.DOMAIN}/rss/${feedId}"
                    >https://${env.DOMAIN}/rss/${feedId}</span
                  >
                  <div class="copy-icon-container">
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
                      <rect
                        x="9"
                        y="9"
                        width="13"
                        height="13"
                        rx="2"
                        ry="2"
                      ></rect>
                      <path
                        d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                      ></path>
                    </svg>
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
                  </div>
                </div>
              </div>
            </div>
          </div>

          <h2>
            Emails (<span id="email-total-count"
              >${feedMetadata.emails.length}</span
            >)
          </h2>

          ${message === "bulkDeleted"
            ? html`<div class="card">
                <p>Deleted ${Number.isFinite(count) ? count : 0} email(s).</p>
              </div>`
            : ""}
          ${message === "bulkDeleteNoop"
            ? html`<div class="card"><p>No emails were selected.</p></div>`
            : ""}
          ${feedMetadata.emails.length > 0
            ? html`
                <form
                  action="/admin/feeds/${feedId}/emails/bulk-delete"
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
                      <span class="pill" id="email-match-count"
                        >Showing ${feedMetadata.emails.length}</span
                      >
                      <span class="pill" id="selected-email-count"
                        >0 selected</span
                      >
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
                              <span
                                class="sort-indicator"
                                aria-hidden="true"
                              ></span>
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
                              <span
                                class="sort-indicator"
                                aria-hidden="true"
                              ></span>
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
                        ${feedMetadata.emails.map((email: EmailMetadata) => {
                          const subjectDisplay = clampText(email.subject, 180);
                          const subjectHover = clampText(email.subject, 1000);
                          const sortSubject = subjectHover.toLowerCase();
                          const sortReceivedAt = String(email.receivedAt);
                          const searchHaystack = clampText(
                            email.subject,
                            320,
                          ).toLowerCase();
                          return html`
                            <tr
                              class="email-row"
                              data-email-key="${email.key}"
                              data-search="${searchHaystack}"
                              data-sort-subject="${sortSubject}"
                              data-sort-received-at="${sortReceivedAt}"
                            >
                              <td>
                                <input
                                  type="checkbox"
                                  class="email-select"
                                  name="emailKeys"
                                  value="${email.key}"
                                  onchange="updateEmailSelectionState()"
                                />
                              </td>
                              <td>
                                <span class="truncate" title="${subjectHover}"
                                  >${subjectDisplay}</span
                                >
                              </td>
                              <td>
                                ${new Date(email.receivedAt).toLocaleString()}
                              </td>
                              <td>
                                <div class="row-actions">
                                  <a
                                    href="/admin/emails/${email.key}"
                                    class="button button-small"
                                    >View</a
                                  >
                                  <button
                                    type="button"
                                    class="button button-small button-danger button-delete"
                                    data-delete-kind="email"
                                    data-email-key="${email.key}"
                                    data-feed-id="${feedId}"
                                  >
                                    Delete
                                  </button>
                                </div>
                              </td>
                            </tr>
                          `;
                        })}
                      </tbody>
                    </table>
                  </div>
                </form>
              `
            : html`<div class="card">
                <p>
                  No emails received yet. Subscribe to newsletters using the
                  email address above.
                </p>
              </div>`}
        </div>

        <script>
          ${raw(`
        const EMAIL_FEED_ID = ${JSON.stringify(feedId)};
        let EMAIL_ROWS = [];
        let EMAIL_CHECKBOXES = [];
        let EMAIL_SELECTED_COUNT_EL = null;
        let EMAIL_MATCH_COUNT_EL = null;
        let EMAIL_TOTAL_COUNT_EL = null;
        let EMAIL_BULK_DELETE_BUTTON_EL = null;
        let EMAIL_SELECT_ALL_EL = null;
        let EMAIL_FILTER_TIMER = null;
        let EMAIL_BULK_DELETE_IN_PROGRESS = false;
        let EMAIL_SORT_KEY = 'receivedAt';
        let EMAIL_SORT_DIR = 'desc';
        const EMAIL_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

        function initEmailUI() {
          EMAIL_ROWS = Array.from(document.querySelectorAll('.email-row'));
          EMAIL_CHECKBOXES = Array.from(document.querySelectorAll('.email-select'));
          EMAIL_SELECTED_COUNT_EL = document.getElementById('selected-email-count');
          EMAIL_MATCH_COUNT_EL = document.getElementById('email-match-count');
          EMAIL_TOTAL_COUNT_EL = document.getElementById('email-total-count');
          EMAIL_BULK_DELETE_BUTTON_EL = document.getElementById('bulk-delete-emails-button');
          EMAIL_SELECT_ALL_EL = document.getElementById('select-all-emails');
          setupEmailTableResizing();
          setupEmailTableSorting();
          setupEmailDeleteButtons();
          updateEmailMatchCount();
          updateEmailSelectionState();
        }

        function updateEmailMatchCount() {
          if (!EMAIL_MATCH_COUNT_EL) return;
          const total = EMAIL_ROWS.length;
          const visible = EMAIL_ROWS.filter((row) => !row.hidden).length;
          const query = (document.getElementById('email-search')?.value || '').trim();
          EMAIL_MATCH_COUNT_EL.textContent = query ? ('Showing ' + visible + ' of ' + total) : ('Showing ' + total);
        }

        function scheduleEmailFilter() {
          if (EMAIL_FILTER_TIMER) clearTimeout(EMAIL_FILTER_TIMER);
          EMAIL_FILTER_TIMER = setTimeout(filterEmailRows, 120);
        }

        function getEmailSortValue(row, key) {
          const prop = 'sort' + key.charAt(0).toUpperCase() + key.slice(1);
          return (row.dataset && row.dataset[prop]) ? row.dataset[prop] : '';
        }

        function updateEmailSortIndicators(table) {
          Array.from(table.querySelectorAll('th[data-sort-key]')).forEach((th) => {
            const key = th.getAttribute('data-sort-key') || '';
            const indicator = th.querySelector('.sort-indicator');
            const active = key === EMAIL_SORT_KEY;
            if (indicator) indicator.textContent = active ? (EMAIL_SORT_DIR === 'asc' ? '^' : 'v') : '';
            th.setAttribute('aria-sort', active ? (EMAIL_SORT_DIR === 'asc' ? 'ascending' : 'descending') : 'none');
          });
        }

        function sortEmailTableBy(key) {
          const table = document.querySelector('table.table-emails');
          const tbody = table ? table.querySelector('tbody') : null;
          if (!table || !tbody) return;
          if (EMAIL_SORT_KEY === key) {
            EMAIL_SORT_DIR = EMAIL_SORT_DIR === 'asc' ? 'desc' : 'asc';
          } else {
            EMAIL_SORT_KEY = key;
            EMAIL_SORT_DIR = key === 'receivedAt' ? 'desc' : 'asc';
          }
          const dir = EMAIL_SORT_DIR === 'asc' ? 1 : -1;
          const rows = Array.from(tbody.querySelectorAll('.email-row'));
          rows.sort((a, b) => dir * EMAIL_COLLATOR.compare(getEmailSortValue(a, EMAIL_SORT_KEY), getEmailSortValue(b, EMAIL_SORT_KEY)));
          const frag = document.createDocumentFragment();
          rows.forEach((row) => frag.appendChild(row));
          tbody.appendChild(frag);
          updateEmailSortIndicators(table);
        }

        function setupEmailTableSorting() {
          const table = document.querySelector('table.table-emails');
          if (!table) return;
          table.querySelectorAll('button.th-button[data-sort-key]').forEach((btn) => {
            btn.addEventListener('click', () => { const key = btn.getAttribute('data-sort-key'); if (key) sortEmailTableBy(key); });
          });
          updateEmailSortIndicators(table);
        }

        function setupEmailTableResizing() {
          const table = document.querySelector('table.table-emails');
          if (!table) return;
          const storageKey = 'email-to-rss.admin.emailsTable.colWidths';
          const minWidths = { subject: 240, receivedAt: 180, actions: 160 };
          const defaultWidths = { subject: 520, receivedAt: 220, actions: 200 };
          const cols = Array.from(table.querySelectorAll('colgroup col'));
          const colByKey = {};
          cols.forEach((col) => { const key = col.getAttribute('data-col'); if (key) colByKey[key] = col; });
          try {
            const saved = JSON.parse(localStorage.getItem(storageKey) || '{}');
            Object.keys(saved || {}).forEach((key) => { const px = Number(saved[key]); if (colByKey[key] && Number.isFinite(px)) colByKey[key].style.width = px + 'px'; });
          } catch { /* ignore */ }
          const persist = () => {
            try {
              const out = {};
              Object.keys(colByKey).forEach((key) => { if (key === 'select') return; const px = parseInt(colByKey[key].style.width || '0', 10); if (Number.isFinite(px) && px > 0) out[key] = px; });
              localStorage.setItem(storageKey, JSON.stringify(out));
            } catch { /* ignore */ }
          };
          let active = null; let rafId = 0; let pendingWidth = 0;
          table.querySelectorAll('.col-resizer').forEach((handle) => {
            handle.addEventListener('pointerdown', (event) => {
              event.preventDefault(); event.stopPropagation();
              const key = handle.getAttribute('data-col'); const col = key ? colByKey[key] : null;
              if (!key || !col) return;
              const th = handle.closest('th');
              const startWidth = th ? th.getBoundingClientRect().width : parseInt(col.style.width || '0', 10) || 200;
              active = { key, col, startX: event.clientX, startWidth };
              document.body.classList.add('is-resizing');
              handle.setPointerCapture(event.pointerId);
            });
            handle.addEventListener('pointermove', (event) => {
              if (!active) return;
              const minPx = minWidths[active.key] || 180;
              pendingWidth = Math.max(minPx, Math.round(active.startWidth + (event.clientX - active.startX)));
              if (rafId) return;
              rafId = requestAnimationFrame(() => { active.col.style.width = pendingWidth + 'px'; rafId = 0; });
            });
            const finish = () => { if (!active) return; active = null; document.body.classList.remove('is-resizing'); persist(); };
            handle.addEventListener('pointerup', finish);
            handle.addEventListener('pointercancel', finish);
            handle.addEventListener('dblclick', (event) => {
              event.preventDefault(); event.stopPropagation();
              const key = handle.getAttribute('data-col'); const col = key ? colByKey[key] : null; const px = key ? defaultWidths[key] : null;
              if (!key || !col || !px) return;
              col.style.width = px + 'px'; persist();
            });
          });
        }

        const EMAIL_DELETE_CONFIRM_LABEL = 'Confirm delete';
        const EMAIL_DELETE_CONFIRM_TIMEOUT_MS = 4000;

        function resetEmailDeleteButton(buttonEl) {
          if (!buttonEl) return;
          buttonEl.classList.remove('is-confirming');
          buttonEl.removeAttribute('data-confirming');
          buttonEl.disabled = false;
          buttonEl.textContent = buttonEl.dataset.originalLabel || 'Delete';
        }

        function setEmailButtonLoading(buttonEl, loading, label) {
          if (!buttonEl) return;
          if (loading) {
            if (!buttonEl.dataset.originalLabel) buttonEl.dataset.originalLabel = (buttonEl.textContent || '').trim();
            buttonEl.classList.add('is-loading');
            buttonEl.disabled = true;
            buttonEl.textContent = '';
            const spinner = document.createElement('span');
            spinner.className = 'spinner';
            spinner.setAttribute('aria-hidden', 'true');
            buttonEl.appendChild(spinner);
            buttonEl.appendChild(document.createTextNode(' ' + (label || 'Working...')));
            return;
          }
          buttonEl.classList.remove('is-loading');
          buttonEl.textContent = buttonEl.dataset.originalLabel || (buttonEl.textContent || '').trim();
        }

        function animateEmailRowRemoval(row, onDone) {
          if (!row) { if (onDone) onDone(); return; }
          row.classList.add('is-removing');
          window.setTimeout(() => { row.remove(); if (onDone) onDone(); }, 240);
        }

        async function deleteEmailRequest(emailKey, feedId) {
          const res = await fetch('/admin/emails/' + encodeURIComponent(emailKey) + '/delete?feedId=' + encodeURIComponent(feedId), {
            method: 'POST', headers: { 'Accept': 'application/json' }, credentials: 'same-origin',
          });
          const data = await res.json().catch(() => ({}));
          if (!res.ok) throw new Error(data && data.error ? String(data.error) : ('Request failed (' + res.status + ')'));
          return data;
        }

        function refreshEmailRowCache() {
          EMAIL_ROWS = Array.from(document.querySelectorAll('.email-row'));
          EMAIL_CHECKBOXES = Array.from(document.querySelectorAll('.email-select'));
          if (EMAIL_TOTAL_COUNT_EL) EMAIL_TOTAL_COUNT_EL.textContent = String(EMAIL_ROWS.length);
          updateEmailMatchCount();
          updateEmailSelectionState();
        }

        function setupEmailDeleteButtons() {
          Array.from(document.querySelectorAll('button[data-delete-kind="email"]')).forEach((button) => {
            if (button.dataset.deleteReady === 'true') return;
            button.dataset.deleteReady = 'true';
            button.dataset.originalLabel = (button.textContent || '').trim() || 'Delete';
            let confirming = false; let confirmTimer = 0; let inFlight = false;
            const startConfirm = () => {
              confirming = true;
              button.classList.add('is-confirming');
              button.setAttribute('data-confirming', 'true');
              button.textContent = EMAIL_DELETE_CONFIRM_LABEL;
              if (confirmTimer) window.clearTimeout(confirmTimer);
              confirmTimer = window.setTimeout(() => { confirming = false; resetEmailDeleteButton(button); }, EMAIL_DELETE_CONFIRM_TIMEOUT_MS);
            };
            button.addEventListener('click', async (event) => {
              event.preventDefault();
              if (inFlight) return;
              if (!confirming) { startConfirm(); return; }
              if (confirmTimer) window.clearTimeout(confirmTimer);
              inFlight = true;
              setEmailButtonLoading(button, true, 'Deleting...');
              const toast = window.showToast ? window.showToast('Deleting email...', { type: 'info', loading: true, duration: 0 }) : null;
              const emailKey = button.getAttribute('data-email-key') || '';
              const feedId = button.getAttribute('data-feed-id') || EMAIL_FEED_ID;
              const row = button.closest('.email-row');
              try {
                await deleteEmailRequest(emailKey, feedId);
                if (toast && toast.update) toast.update('Email deleted.', { type: 'success', loading: false, duration: 3200 });
                else if (window.showToast) window.showToast('Email deleted.', { type: 'success' });
                animateEmailRowRemoval(row, () => refreshEmailRowCache());
              } catch (error) {
                const msg = 'Delete failed: ' + (error && error.message ? error.message : 'Unknown error');
                if (toast && toast.update) toast.update(msg, { type: 'error', loading: false });
                else if (window.showToast) window.showToast(msg, { type: 'error' });
                setEmailButtonLoading(button, false); confirming = false; resetEmailDeleteButton(button);
              } finally {
                inFlight = false;
                if (!row) { setEmailButtonLoading(button, false); confirming = false; resetEmailDeleteButton(button); }
              }
            });
            button.addEventListener('keydown', (event) => {
              if (event.key === 'Escape' && confirming && !inFlight) { confirming = false; if (confirmTimer) window.clearTimeout(confirmTimer); resetEmailDeleteButton(button); }
            });
          });
        }

        function updateEmailSelectionState() {
          if (!EMAIL_CHECKBOXES.length) return;
          const selected = EMAIL_CHECKBOXES.filter((c) => c.checked);
          if (EMAIL_SELECTED_COUNT_EL) EMAIL_SELECTED_COUNT_EL.textContent = selected.length + ' selected';
          if (EMAIL_BULK_DELETE_BUTTON_EL) EMAIL_BULK_DELETE_BUTTON_EL.disabled = selected.length === 0;
          if (EMAIL_SELECT_ALL_EL) {
            const visible = EMAIL_CHECKBOXES.filter((c) => !c.closest('tr')?.hidden);
            EMAIL_SELECT_ALL_EL.checked = visible.length > 0 && visible.every((c) => c.checked);
          }
        }

        function toggleAllEmails(checked) { EMAIL_CHECKBOXES.forEach((c) => { if (!c.closest('tr')?.hidden) c.checked = checked; }); updateEmailSelectionState(); }
        function selectMatchingEmails() { EMAIL_CHECKBOXES.forEach((c) => { if (!c.closest('tr')?.hidden) c.checked = true; }); updateEmailSelectionState(); }
        function clearEmailSelection() { EMAIL_CHECKBOXES.forEach((c) => { c.checked = false; }); updateEmailSelectionState(); }

        function filterEmailRows() {
          const query = (document.getElementById('email-search')?.value || '').toLowerCase().trim();
          EMAIL_ROWS.forEach((row) => { row.hidden = !!query && !(row.getAttribute('data-search') || '').includes(query); });
          updateEmailMatchCount(); updateEmailSelectionState();
        }

        function confirmBulkEmailDelete() {
          const selected = EMAIL_CHECKBOXES.filter((c) => c.checked).length;
          if (selected === 0) return false;
          const query = (document.getElementById('email-search')?.value || '').trim();
          const extra = selected >= 200 && !query ? '\n\nThis is a large delete. Tip: use Search to narrow down spam first.' : '';
          return confirm('Delete ' + selected + ' selected email(s)?' + extra);
        }

        function removeEmailRowsByKey(emailKeys) {
          const toRemove = new Set((emailKeys || []).map((v) => String(v)));
          if (!toRemove.size) return;
          EMAIL_ROWS.forEach((row) => { const cb = row.querySelector('input.email-select'); if (cb && toRemove.has(cb.value)) row.remove(); });
          EMAIL_ROWS = Array.from(document.querySelectorAll('.email-row'));
          EMAIL_CHECKBOXES = Array.from(document.querySelectorAll('.email-select'));
          if (EMAIL_TOTAL_COUNT_EL) EMAIL_TOTAL_COUNT_EL.textContent = String(EMAIL_ROWS.length);
        }

        function onBulkEmailDeleteSubmit(event) { if (event && event.preventDefault) event.preventDefault(); void bulkDeleteSelectedEmails(); return false; }

        async function bulkDeleteSelectedEmails() {
          if (EMAIL_BULK_DELETE_IN_PROGRESS) return;
          const selectedKeys = EMAIL_CHECKBOXES.filter((c) => c.checked).map((c) => c.value);
          if (!selectedKeys.length) { if (window.showToast) window.showToast('No emails selected.', { type: 'info' }); return; }
          if (!confirmBulkEmailDelete()) return;
          EMAIL_BULK_DELETE_IN_PROGRESS = true;
          setEmailButtonLoading(EMAIL_BULK_DELETE_BUTTON_EL, true, 'Deleting...');
          const toast = window.showToast ? window.showToast('Deleting ' + selectedKeys.length + ' email(s)...', { type: 'info', loading: true, duration: 0 }) : null;
          const batchSize = 50; let deletedTotal = 0; const failed = [];
          try {
            const url = '/admin/feeds/' + encodeURIComponent(EMAIL_FEED_ID) + '/emails/bulk-delete';
            for (let i = 0; i < selectedKeys.length; i += batchSize) {
              const batch = selectedKeys.slice(i, i + batchSize);
              const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ emailKeys: batch }) });
              let data = {};
              if (window.parseJsonResponseOrThrow) { data = await window.parseJsonResponseOrThrow(res, { prefix: 'Bulk email delete failed' }); }
              else { data = await res.json().catch(() => ({})); if (!res.ok) throw new Error(data && data.error ? String(data.error) : 'Bulk email delete failed (HTTP ' + res.status + ')'); }
              const deletedKeys = Array.isArray(data.deletedEmailKeys) ? data.deletedEmailKeys : batch;
              removeEmailRowsByKey(deletedKeys); deletedTotal += deletedKeys.length;
              failed.push(...(Array.isArray(data.failedEmailKeys) ? data.failedEmailKeys : []));
              if (toast && toast.update) toast.update('Deleting... (' + Math.min(i + batch.length, selectedKeys.length) + ' of ' + selectedKeys.length + ')', { type: 'info' });
              updateEmailMatchCount(); updateEmailSelectionState();
            }
            if (toast && toast.dismiss) toast.dismiss();
            if (failed.length > 0) { if (window.showToast) window.showToast('Deleted ' + deletedTotal + ' email(s). ' + failed.length + ' failed (still visible).', { type: 'error' }); }
            else { if (window.showToast) window.showToast('Deleted ' + deletedTotal + ' email(s).', { type: 'success' }); }
          } catch (error) {
            if (toast && toast.dismiss) toast.dismiss();
            if (window.showToast) window.showToast((error && error.message) ? error.message : 'Bulk email delete failed.', { type: 'error' });
          } finally {
            EMAIL_BULK_DELETE_IN_PROGRESS = false;
            setEmailButtonLoading(EMAIL_BULK_DELETE_BUTTON_EL, false);
            updateEmailSelectionState();
          }
        }

        document.addEventListener('DOMContentLoaded', () => { initEmailUI(); });
      `)};
        </script>
      `,
    ),
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

  return c.html(
    layout(
      `Email: ${emailData.subject}`,
      html`
        <div class="container fade-in">
          <div class="header-with-actions">
            <div class="header-title"><h1>Email Content</h1></div>
            <div class="header-actions">
              <a
                href="/admin/feeds/${feedId}/emails"
                class="button button-secondary button-back"
                >Back to Emails</a
              >
            </div>
          </div>

          <div class="card">
            <div class="email-meta">
              <div class="email-metadata-grid">
                <div class="copyable">
                  <span class="copyable-label">Subject:</span>
                  <div class="copyable-content">
                    <span
                      class="copyable-value"
                      data-copy="${emailData.subject}"
                      >${emailData.subject}</span
                    >
                    <div class="copy-icon-container">
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
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
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
                    </div>
                  </div>
                </div>
                <div class="copyable">
                  <span class="copyable-label">Received:</span>
                  <div class="copyable-content">
                    <span
                      class="copyable-value"
                      data-copy="${new Date(
                        emailData.receivedAt,
                      ).toLocaleString()}"
                      >${new Date(emailData.receivedAt).toLocaleString()}</span
                    >
                    <div class="copy-icon-container">
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
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
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
                    </div>
                  </div>
                </div>
                <div class="copyable">
                  <span class="copyable-label">From:</span>
                  <div class="copyable-content">
                    <span class="copyable-value" data-copy="${emailData.from}"
                      >${emailData.from}</span
                    >
                    <div class="copy-icon-container">
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
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
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
                    </div>
                  </div>
                </div>
                <div class="copyable">
                  <span class="copyable-label">To:</span>
                  <div class="copyable-content">
                    <span
                      class="copyable-value"
                      data-copy="${feedId}@${env.DOMAIN}"
                      >${feedId}@${env.DOMAIN}</span
                    >
                    <div class="copy-icon-container">
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
                        <rect
                          x="9"
                          y="9"
                          width="13"
                          height="13"
                          rx="2"
                          ry="2"
                        ></rect>
                        <path
                          d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"
                        ></path>
                      </svg>
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
                    </div>
                  </div>
                </div>
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
                  src="data:text/html;base64,${encodedHtmlContent}"
                ></iframe>
              </div>
              <div id="raw-view" class="email-raw" style="display: none;">
                <pre>
${emailData.content.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</pre
                >
              </div>
            </div>
          </div>
        </div>

        <script>
          ${raw(`
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
      `)};
        </script>
      `,
    ),
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
