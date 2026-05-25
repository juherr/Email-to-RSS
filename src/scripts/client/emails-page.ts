// Client-side script for the admin emails page.
// Compiled by scripts/build-client.mjs — do not import DOM types from here in Worker code.
// feedId is read at runtime from window.__APP_CONFIG__ (injected as a config bootstrap script before this one).

const EMAIL_FEED_ID: string =
  (window as unknown as { __APP_CONFIG__?: { feedId?: string } }).__APP_CONFIG__
    ?.feedId ?? "";

let EMAIL_ROWS: HTMLElement[] = [];
let EMAIL_CHECKBOXES: HTMLInputElement[] = [];
let EMAIL_SELECTED_COUNT_EL: HTMLElement | null = null;
let EMAIL_MATCH_COUNT_EL: HTMLElement | null = null;
let EMAIL_TOTAL_COUNT_EL: HTMLElement | null = null;
let EMAIL_BULK_DELETE_BUTTON_EL: HTMLButtonElement | null = null;
let EMAIL_SELECT_ALL_EL: HTMLInputElement | null = null;
let EMAIL_FILTER_TIMER: ReturnType<typeof setTimeout> | null = null;
let EMAIL_BULK_DELETE_IN_PROGRESS = false;
let EMAIL_SORT_KEY = "receivedAt";
let EMAIL_SORT_DIR = "desc";
const EMAIL_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function initEmailUI(): void {
  EMAIL_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".email-row"));
  EMAIL_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".email-select"),
  );
  EMAIL_SELECTED_COUNT_EL = document.getElementById("selected-email-count");
  EMAIL_MATCH_COUNT_EL = document.getElementById("email-match-count");
  EMAIL_TOTAL_COUNT_EL = document.getElementById("email-total-count");
  EMAIL_BULK_DELETE_BUTTON_EL = document.getElementById(
    "bulk-delete-emails-button",
  ) as HTMLButtonElement | null;
  EMAIL_SELECT_ALL_EL = document.getElementById(
    "select-all-emails",
  ) as HTMLInputElement | null;
  setupEmailTableResizing();
  setupEmailTableSorting();
  setupEmailDeleteButtons();
  updateEmailMatchCount();
  updateEmailSelectionState();
}

function updateEmailMatchCount(): void {
  if (!EMAIL_MATCH_COUNT_EL) return;
  const total = EMAIL_ROWS.length;
  const visible = EMAIL_ROWS.filter((row) => !row.hidden).length;
  const query = (
    (document.getElementById("email-search") as HTMLInputElement | null)
      ?.value || ""
  ).trim();
  EMAIL_MATCH_COUNT_EL.textContent = query
    ? "Showing " + visible + " of " + total
    : "Showing " + total;
}

function scheduleEmailFilter(): void {
  if (EMAIL_FILTER_TIMER) clearTimeout(EMAIL_FILTER_TIMER);
  EMAIL_FILTER_TIMER = setTimeout(filterEmailRows, 120);
}

function getEmailSortValue(row: HTMLElement, key: string): string {
  const prop = "sort" + key.charAt(0).toUpperCase() + key.slice(1);
  return row.dataset && row.dataset[prop] ? row.dataset[prop]! : "";
}

function updateEmailSortIndicators(table: Element): void {
  Array.from(table.querySelectorAll<HTMLElement>("th[data-sort-key]")).forEach(
    (th) => {
      const key = th.getAttribute("data-sort-key") || "";
      const indicator = th.querySelector(".sort-indicator");
      const active = key === EMAIL_SORT_KEY;
      if (indicator)
        indicator.textContent = active
          ? EMAIL_SORT_DIR === "asc"
            ? "^"
            : "v"
          : "";
      th.setAttribute(
        "aria-sort",
        active
          ? EMAIL_SORT_DIR === "asc"
            ? "ascending"
            : "descending"
          : "none",
      );
    },
  );
}

function sortEmailTableBy(key: string): void {
  const table = document.querySelector("table.table-emails");
  const tbody = table ? table.querySelector("tbody") : null;
  if (!table || !tbody) return;
  if (EMAIL_SORT_KEY === key) {
    EMAIL_SORT_DIR = EMAIL_SORT_DIR === "asc" ? "desc" : "asc";
  } else {
    EMAIL_SORT_KEY = key;
    EMAIL_SORT_DIR = key === "receivedAt" ? "desc" : "asc";
  }
  const dir = EMAIL_SORT_DIR === "asc" ? 1 : -1;
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".email-row"));
  rows.sort(
    (a, b) =>
      dir *
      EMAIL_COLLATOR.compare(
        getEmailSortValue(a, EMAIL_SORT_KEY),
        getEmailSortValue(b, EMAIL_SORT_KEY),
      ),
  );
  const frag = document.createDocumentFragment();
  rows.forEach((row) => frag.appendChild(row));
  tbody.appendChild(frag);
  updateEmailSortIndicators(table);
}

function setupEmailTableSorting(): void {
  const table = document.querySelector("table.table-emails");
  if (!table) return;
  table
    .querySelectorAll<HTMLButtonElement>("button.th-button[data-sort-key]")
    .forEach((btn) => {
      btn.addEventListener("click", () => {
        const key = btn.getAttribute("data-sort-key");
        if (key) sortEmailTableBy(key);
      });
    });
  updateEmailSortIndicators(table);
}

function setupEmailTableResizing(): void {
  const table = document.querySelector("table.table-emails");
  if (!table) return;
  const storageKey = "email-to-rss.admin.emailsTable.colWidths";
  const minWidths: Record<string, number> = {
    subject: 240,
    receivedAt: 180,
    actions: 160,
  };
  const defaultWidths: Record<string, number> = {
    subject: 520,
    receivedAt: 220,
    actions: 200,
  };
  const cols = Array.from(table.querySelectorAll<HTMLElement>("colgroup col"));
  const colByKey: Record<string, HTMLElement> = {};
  cols.forEach((col) => {
    const key = col.getAttribute("data-col");
    if (key) colByKey[key] = col;
  });
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) || "{}",
    ) as Record<string, unknown>;
    Object.keys(saved || {}).forEach((key) => {
      const px = Number(saved[key]);
      if (colByKey[key] && Number.isFinite(px))
        colByKey[key].style.width = px + "px";
    });
  } catch {
    /* ignore */
  }
  const persist = () => {
    try {
      const out: Record<string, number> = {};
      Object.keys(colByKey).forEach((key) => {
        if (key === "select") return;
        const px = parseInt(colByKey[key].style.width || "0", 10);
        if (Number.isFinite(px) && px > 0) out[key] = px;
      });
      localStorage.setItem(storageKey, JSON.stringify(out));
    } catch {
      /* ignore */
    }
  };
  type ActiveResize = {
    key: string;
    col: HTMLElement;
    startX: number;
    startWidth: number;
  };
  let active: ActiveResize | null = null;
  let rafId = 0;
  let pendingWidth = 0;
  table.querySelectorAll<HTMLElement>(".col-resizer").forEach((handle) => {
    handle.addEventListener("pointerdown", (event: PointerEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = handle.getAttribute("data-col");
      const col = key ? colByKey[key] : null;
      if (!key || !col) return;
      const th = handle.closest("th");
      const startWidth = th
        ? th.getBoundingClientRect().width
        : parseInt(col.style.width || "0", 10) || 200;
      active = { key, col, startX: event.clientX, startWidth };
      document.body.classList.add("is-resizing");
      handle.setPointerCapture(event.pointerId);
    });
    handle.addEventListener("pointermove", (event: PointerEvent) => {
      if (!active) return;
      const minPx = minWidths[active.key] || 180;
      pendingWidth = Math.max(
        minPx,
        Math.round(active.startWidth + (event.clientX - active.startX)),
      );
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        active!.col.style.width = pendingWidth + "px";
        rafId = 0;
      });
    });
    const finish = () => {
      if (!active) return;
      active = null;
      document.body.classList.remove("is-resizing");
      persist();
    };
    handle.addEventListener("pointerup", finish);
    handle.addEventListener("pointercancel", finish);
    handle.addEventListener("dblclick", (event: MouseEvent) => {
      event.preventDefault();
      event.stopPropagation();
      const key = handle.getAttribute("data-col");
      const col = key ? colByKey[key] : null;
      const px = key ? defaultWidths[key] : null;
      if (!key || !col || !px) return;
      col.style.width = px + "px";
      persist();
    });
  });
}

const EMAIL_DELETE_CONFIRM_LABEL = "Confirm delete";
const EMAIL_DELETE_CONFIRM_TIMEOUT_MS = 4000;

function resetEmailDeleteButton(buttonEl: HTMLButtonElement): void {
  if (!buttonEl) return;
  buttonEl.classList.remove("is-confirming");
  buttonEl.removeAttribute("data-confirming");
  buttonEl.disabled = false;
  buttonEl.textContent = buttonEl.dataset.originalLabel || "Delete";
}

function setEmailButtonLoading(
  buttonEl: HTMLButtonElement | null,
  loading: boolean,
  label?: string,
): void {
  if (!buttonEl) return;
  if (loading) {
    if (!buttonEl.dataset.originalLabel)
      buttonEl.dataset.originalLabel = (buttonEl.textContent || "").trim();
    buttonEl.classList.add("is-loading");
    buttonEl.disabled = true;
    buttonEl.textContent = "";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    spinner.setAttribute("aria-hidden", "true");
    buttonEl.appendChild(spinner);
    buttonEl.appendChild(
      document.createTextNode(" " + (label || "Working...")),
    );
    return;
  }
  buttonEl.classList.remove("is-loading");
  buttonEl.textContent =
    buttonEl.dataset.originalLabel || (buttonEl.textContent || "").trim();
}

function animateEmailRowRemoval(
  row: HTMLElement | null,
  onDone?: () => void,
): void {
  if (!row) {
    if (onDone) onDone();
    return;
  }
  row.classList.add("is-removing");
  window.setTimeout(() => {
    row.remove();
    if (onDone) onDone();
  }, 240);
}

async function deleteEmailRequest(
  emailKey: string,
  feedId: string,
): Promise<unknown> {
  const res = await fetch(
    "/admin/emails/" +
      encodeURIComponent(emailKey) +
      "/delete?feedId=" +
      encodeURIComponent(feedId),
    {
      method: "POST",
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok)
    throw new Error(
      data && data.error
        ? String(data.error)
        : "Request failed (" + res.status + ")",
    );
  return data;
}

function refreshEmailRowCache(): void {
  EMAIL_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".email-row"));
  EMAIL_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".email-select"),
  );
  if (EMAIL_TOTAL_COUNT_EL)
    EMAIL_TOTAL_COUNT_EL.textContent = String(EMAIL_ROWS.length);
  updateEmailMatchCount();
  updateEmailSelectionState();
}

function setupEmailDeleteButtons(): void {
  Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[data-delete-kind="email"]',
    ),
  ).forEach((button) => {
    if (button.dataset.deleteReady === "true") return;
    button.dataset.deleteReady = "true";
    button.dataset.originalLabel =
      (button.textContent || "").trim() || "Delete";
    let confirming = false;
    let confirmTimer = 0;
    let inFlight = false;
    const startConfirm = () => {
      confirming = true;
      button.classList.add("is-confirming");
      button.setAttribute("data-confirming", "true");
      button.textContent = EMAIL_DELETE_CONFIRM_LABEL;
      if (confirmTimer) window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => {
        confirming = false;
        resetEmailDeleteButton(button);
      }, EMAIL_DELETE_CONFIRM_TIMEOUT_MS);
    };
    button.addEventListener("click", async (event: MouseEvent) => {
      event.preventDefault();
      if (inFlight) return;
      if (!confirming) {
        startConfirm();
        return;
      }
      if (confirmTimer) window.clearTimeout(confirmTimer);
      inFlight = true;
      setEmailButtonLoading(button, true, "Deleting...");
      const toast = window.showToast
        ? window.showToast("Deleting email...", {
            type: "info",
            loading: true,
            duration: 0,
          })
        : null;
      const emailKey = button.getAttribute("data-email-key") || "";
      const feedId = button.getAttribute("data-feed-id") || EMAIL_FEED_ID;
      const row = button.closest<HTMLElement>(".email-row");
      try {
        await deleteEmailRequest(emailKey, feedId);
        if (toast && toast.update)
          toast.update("Email deleted.", {
            type: "success",
            loading: false,
            duration: 3200,
          });
        else if (window.showToast)
          window.showToast("Email deleted.", { type: "success" });
        animateEmailRowRemoval(row, () => refreshEmailRowCache());
      } catch (error) {
        const msg =
          "Delete failed: " +
          (error instanceof Error && error.message
            ? error.message
            : "Unknown error");
        if (toast && toast.update)
          toast.update(msg, { type: "error", loading: false });
        else if (window.showToast) window.showToast(msg, { type: "error" });
        setEmailButtonLoading(button, false);
        confirming = false;
        resetEmailDeleteButton(button);
      } finally {
        inFlight = false;
        if (!row) {
          setEmailButtonLoading(button, false);
          confirming = false;
          resetEmailDeleteButton(button);
        }
      }
    });
    button.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && confirming && !inFlight) {
        confirming = false;
        if (confirmTimer) window.clearTimeout(confirmTimer);
        resetEmailDeleteButton(button);
      }
    });
  });
}

function updateEmailSelectionState(): void {
  if (!EMAIL_CHECKBOXES.length) return;
  const selected = EMAIL_CHECKBOXES.filter((c) => c.checked);
  if (EMAIL_SELECTED_COUNT_EL)
    EMAIL_SELECTED_COUNT_EL.textContent = selected.length + " selected";
  if (EMAIL_BULK_DELETE_BUTTON_EL)
    EMAIL_BULK_DELETE_BUTTON_EL.disabled = selected.length === 0;
  if (EMAIL_SELECT_ALL_EL) {
    const visible = EMAIL_CHECKBOXES.filter(
      (c) => !(c.closest("tr") as HTMLElement | null)?.hidden,
    );
    EMAIL_SELECT_ALL_EL.checked =
      visible.length > 0 && visible.every((c) => c.checked);
  }
}

function toggleAllEmails(checked: boolean): void {
  EMAIL_CHECKBOXES.forEach((c) => {
    if (!(c.closest("tr") as HTMLElement | null)?.hidden) c.checked = checked;
  });
  updateEmailSelectionState();
}
function selectMatchingEmails(): void {
  EMAIL_CHECKBOXES.forEach((c) => {
    if (!(c.closest("tr") as HTMLElement | null)?.hidden) c.checked = true;
  });
  updateEmailSelectionState();
}
function clearEmailSelection(): void {
  EMAIL_CHECKBOXES.forEach((c) => {
    c.checked = false;
  });
  updateEmailSelectionState();
}

function filterEmailRows(): void {
  const query = (
    (document.getElementById("email-search") as HTMLInputElement | null)
      ?.value || ""
  )
    .toLowerCase()
    .trim();
  EMAIL_ROWS.forEach((row) => {
    row.hidden =
      !!query && !(row.getAttribute("data-search") || "").includes(query);
  });
  updateEmailMatchCount();
  updateEmailSelectionState();
}

function confirmBulkEmailDelete(): boolean {
  const selected = EMAIL_CHECKBOXES.filter((c) => c.checked).length;
  if (selected === 0) return false;
  const query = (
    (document.getElementById("email-search") as HTMLInputElement | null)
      ?.value || ""
  ).trim();
  const extra =
    selected >= 200 && !query
      ? "\n\nThis is a large delete. Tip: use Search to narrow down spam first."
      : "";
  return confirm("Delete " + selected + " selected email(s)?" + extra);
}

function removeEmailRowsByKey(emailKeys: string[]): void {
  const toRemove = new Set((emailKeys || []).map((v) => String(v)));
  if (!toRemove.size) return;
  EMAIL_ROWS.forEach((row) => {
    const cb = row.querySelector<HTMLInputElement>("input.email-select");
    if (cb && toRemove.has(cb.value)) row.remove();
  });
  EMAIL_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".email-row"));
  EMAIL_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".email-select"),
  );
  if (EMAIL_TOTAL_COUNT_EL)
    EMAIL_TOTAL_COUNT_EL.textContent = String(EMAIL_ROWS.length);
}

function onBulkEmailDeleteSubmit(event: Event): boolean {
  if (event && event.preventDefault) event.preventDefault();
  void bulkDeleteSelectedEmails();
  return false;
}

async function bulkDeleteSelectedEmails(): Promise<void> {
  if (EMAIL_BULK_DELETE_IN_PROGRESS) return;
  const selectedKeys = EMAIL_CHECKBOXES.filter((c) => c.checked).map(
    (c) => c.value,
  );
  if (!selectedKeys.length) {
    if (window.showToast)
      window.showToast("No emails selected.", { type: "info" });
    return;
  }
  if (!confirmBulkEmailDelete()) return;
  EMAIL_BULK_DELETE_IN_PROGRESS = true;
  setEmailButtonLoading(EMAIL_BULK_DELETE_BUTTON_EL, true, "Deleting...");
  const toast = window.showToast
    ? window.showToast("Deleting " + selectedKeys.length + " email(s)...", {
        type: "info",
        loading: true,
        duration: 0,
      })
    : null;
  const batchSize = 50;
  let deletedTotal = 0;
  const failed: string[] = [];
  try {
    const url =
      "/admin/feeds/" +
      encodeURIComponent(EMAIL_FEED_ID) +
      "/emails/bulk-delete";
    for (let i = 0; i < selectedKeys.length; i += batchSize) {
      const batch = selectedKeys.slice(i, i + batchSize);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ emailKeys: batch }),
      });
      let data: Record<string, unknown> = {};
      if (window.parseJsonResponseOrThrow) {
        data = await window.parseJsonResponseOrThrow(res, {
          prefix: "Bulk email delete failed",
        });
      } else {
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok)
          throw new Error(
            data && data.error
              ? String(data.error)
              : "Bulk email delete failed (HTTP " + res.status + ")",
          );
      }
      const deletedKeys = Array.isArray(data.deletedEmailKeys)
        ? (data.deletedEmailKeys as string[])
        : batch;
      removeEmailRowsByKey(deletedKeys);
      deletedTotal += deletedKeys.length;
      failed.push(
        ...(Array.isArray(data.failedEmailKeys)
          ? (data.failedEmailKeys as string[])
          : []),
      );
      if (toast && toast.update)
        toast.update(
          "Deleting... (" +
            Math.min(i + batch.length, selectedKeys.length) +
            " of " +
            selectedKeys.length +
            ")",
          { type: "info" },
        );
      updateEmailMatchCount();
      updateEmailSelectionState();
    }
    if (toast && toast.dismiss) toast.dismiss();
    if (failed.length > 0) {
      if (window.showToast)
        window.showToast(
          "Deleted " +
            deletedTotal +
            " email(s). " +
            failed.length +
            " failed (still visible).",
          { type: "error" },
        );
    } else {
      if (window.showToast)
        window.showToast("Deleted " + deletedTotal + " email(s).", {
          type: "success",
        });
    }
  } catch (error) {
    if (toast && toast.dismiss) toast.dismiss();
    if (window.showToast)
      window.showToast(
        error instanceof Error && error.message
          ? error.message
          : "Bulk email delete failed.",
        { type: "error" },
      );
  } finally {
    EMAIL_BULK_DELETE_IN_PROGRESS = false;
    setEmailButtonLoading(EMAIL_BULK_DELETE_BUTTON_EL, false);
    updateEmailSelectionState();
  }
}

// Expose functions needed by inline HTML event handlers
(window as unknown as Record<string, unknown>).scheduleEmailFilter =
  scheduleEmailFilter;
(window as unknown as Record<string, unknown>).toggleAllEmails =
  toggleAllEmails;
(window as unknown as Record<string, unknown>).selectMatchingEmails =
  selectMatchingEmails;
(window as unknown as Record<string, unknown>).clearEmailSelection =
  clearEmailSelection;
(window as unknown as Record<string, unknown>).onBulkEmailDeleteSubmit =
  onBulkEmailDeleteSubmit;

document.addEventListener("DOMContentLoaded", () => {
  initEmailUI();
});

// ── Confirmation banner dismiss ───────────────────────────────────────────────

const dismissBtn = document.getElementById("confirmation-dismiss");
const banner = document.getElementById("confirmation-banner");
if (dismissBtn && banner) {
  dismissBtn.addEventListener("click", () => {
    const feedId = banner.getAttribute("data-feed-id") ?? "";
    fetch(`/admin/feeds/${feedId}/confirmation/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((r) => r.json())
      .then((d) => {
        if ((d as { ok?: boolean }).ok) banner.remove();
      })
      .catch(() => {});
  });
}

// ── Native-feed banner dismiss ────────────────────────────────────────────────

const nativeDismissBtn = document.getElementById("native-feed-dismiss");
const nativeBanner = document.getElementById("native-feed-banner");
if (nativeDismissBtn && nativeBanner) {
  nativeDismissBtn.addEventListener("click", () => {
    const feedId = nativeBanner.getAttribute("data-feed-id") ?? "";
    fetch(`/admin/feeds/${feedId}/native-feed/dismiss`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    })
      .then((r) => r.json())
      .then((d) => {
        if ((d as { ok?: boolean }).ok) nativeBanner.remove();
      })
      .catch(() => {});
  });
}
