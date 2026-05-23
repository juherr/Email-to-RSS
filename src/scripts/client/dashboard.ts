// Client-side script for the admin dashboard (feeds table).
// Compiled by scripts/build-client.mjs — do not import DOM types from here in Worker code.

let FEED_ROWS: HTMLElement[] = [];
let FEED_CHECKBOXES: HTMLInputElement[] = [];
let FEED_SELECTED_COUNT_EL: HTMLElement | null = null;
let FEED_MATCH_COUNT_EL: HTMLElement | null = null;
let FEED_TOTAL_COUNT_EL: HTMLElement | null = null;
let FEED_BULK_DELETE_BUTTON_EL: HTMLButtonElement | null = null;
let FEED_SELECT_ALL_EL: HTMLInputElement | null = null;
let FEED_FILTER_TIMER: ReturnType<typeof setTimeout> | null = null;
let FEED_BULK_DELETE_IN_PROGRESS = false;
let FEED_SORT_KEY = "title";
let FEED_SORT_DIR = "asc";
const FEED_COLLATOR = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function initFeedUI(): void {
  FEED_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".feed-row"));
  FEED_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".feed-select"),
  );
  FEED_SELECTED_COUNT_EL = document.getElementById("selected-feed-count");
  FEED_MATCH_COUNT_EL = document.getElementById("feed-match-count");
  FEED_TOTAL_COUNT_EL = document.getElementById("feed-total-count");
  FEED_BULK_DELETE_BUTTON_EL = document.getElementById(
    "bulk-delete-feeds-button",
  ) as HTMLButtonElement | null;
  FEED_SELECT_ALL_EL = document.getElementById(
    "select-all-feeds",
  ) as HTMLInputElement | null;
  setupFeedTableResizing();
  setupFeedTableSorting();
  setupFeedDeleteButtons();
  updateFeedMatchCount();
  updateFeedSelectionState();
}

function updateFeedMatchCount(): void {
  if (!FEED_MATCH_COUNT_EL) return;
  const total = FEED_ROWS.length;
  const visible = FEED_ROWS.filter((row) => !row.hidden).length;
  const query = (
    (document.getElementById("feed-search") as HTMLInputElement | null)
      ?.value || ""
  ).trim();
  FEED_MATCH_COUNT_EL.textContent = query
    ? "Showing " + visible + " of " + total
    : "Showing " + total;
}

function scheduleFeedFilter(): void {
  if (FEED_FILTER_TIMER) {
    clearTimeout(FEED_FILTER_TIMER);
  }
  FEED_FILTER_TIMER = setTimeout(filterFeedRows, 120);
}

function getSortValue(row: HTMLElement, key: string): string {
  const prop = "sort" + key.charAt(0).toUpperCase() + key.slice(1);
  return row.dataset && row.dataset[prop] ? row.dataset[prop]! : "";
}

function updateFeedSortIndicators(table: Element): void {
  const headerCells = Array.from(
    table.querySelectorAll<HTMLElement>("th[data-sort-key]"),
  );
  headerCells.forEach((th) => {
    const key = th.getAttribute("data-sort-key") || "";
    const indicator = th.querySelector(".sort-indicator");
    const active = key === FEED_SORT_KEY;

    if (indicator) {
      indicator.textContent = active
        ? FEED_SORT_DIR === "asc"
          ? "^"
          : "v"
        : "";
    }
    th.setAttribute(
      "aria-sort",
      active ? (FEED_SORT_DIR === "asc" ? "ascending" : "descending") : "none",
    );
  });
}

function sortFeedTableBy(key: string): void {
  const table = document.querySelector("table.table-feeds");
  const tbody = document.getElementById("feed-table-body");
  if (!table || !tbody) return;

  if (FEED_SORT_KEY === key) {
    FEED_SORT_DIR = FEED_SORT_DIR === "asc" ? "desc" : "asc";
  } else {
    FEED_SORT_KEY = key;
    FEED_SORT_DIR = "asc";
  }

  const dirMultiplier = FEED_SORT_DIR === "asc" ? 1 : -1;
  const rows = Array.from(tbody.querySelectorAll<HTMLElement>(".feed-row"));
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

function setupFeedTableSorting(): void {
  const table = document.querySelector("table.table-feeds");
  if (!table) return;

  table
    .querySelectorAll<HTMLButtonElement>("button.th-button[data-sort-key]")
    .forEach((button) => {
      button.addEventListener("click", () => {
        const key = button.getAttribute("data-sort-key") || "";
        if (!key) return;
        sortFeedTableBy(key);
      });
    });

  updateFeedSortIndicators(table);
}

function setupFeedTableResizing(): void {
  const table = document.querySelector("table.table-feeds");
  if (!table) return;

  const storageKey = "email-to-rss.admin.feedsTable.colWidths";
  const minWidths: Record<string, number> = {
    title: 220,
    feedId: 120,
    email: 160,
    rss: 160,
    actions: 160,
  };
  const defaultWidths: Record<string, number> = {
    title: 340,
    feedId: 160,
    email: 220,
    rss: 220,
    actions: 200,
  };

  const cols = Array.from(table.querySelectorAll<HTMLElement>("colgroup col"));
  const colByKey: Record<string, HTMLElement> = {};
  cols.forEach((col) => {
    const key = col.getAttribute("data-col");
    if (key) colByKey[key] = col;
  });

  // Restore widths
  try {
    const saved = JSON.parse(
      localStorage.getItem(storageKey) || "{}",
    ) as Record<string, unknown>;
    Object.keys(saved || {}).forEach((key) => {
      const px = Number(saved[key]);
      if (!colByKey[key] || !Number.isFinite(px)) return;
      colByKey[key].style.width = px + "px";
    });
  } catch {
    // Ignore bad localStorage values
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
      // localStorage may be unavailable in some modes; ignore
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
        : parseInt(col.style.width || "0", 10) || 120;

      active = { key, col, startX: event.clientX, startWidth };
      document.body.classList.add("is-resizing");
      handle.setPointerCapture(event.pointerId);
    });

    handle.addEventListener("pointermove", (event: PointerEvent) => {
      if (!active) return;
      const minPx = minWidths[active.key] || 120;
      const nextWidth = Math.max(
        minPx,
        Math.round(active.startWidth + (event.clientX - active.startX)),
      );
      pendingWidth = nextWidth;
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

const DELETE_CONFIRM_LABEL = "Confirm delete";
const DELETE_LOADING_LABEL = "Deleting...";
const DELETE_CONFIRM_TIMEOUT_MS = 4000;

function getDeleteView(): string {
  return new URL(window.location.href).searchParams.get("view") || "list";
}

function resetDeleteButton(buttonEl: HTMLButtonElement): void {
  if (!buttonEl) return;
  buttonEl.classList.remove("is-confirming");
  buttonEl.removeAttribute("data-confirming");
  buttonEl.disabled = false;
  const original =
    buttonEl.dataset.originalLabel ||
    (buttonEl.textContent || "").trim() ||
    "Delete";
  buttonEl.innerHTML = original;
}

function animateRowRemoval(row: HTMLElement | null, onDone?: () => void): void {
  if (!row) {
    if (onDone) onDone();
    return;
  }

  const isListItem = row.tagName.toLowerCase() === "li";
  if (isListItem) {
    row.style.maxHeight = row.getBoundingClientRect().height + "px";
    row.style.overflow = "hidden";
  }

  row.classList.add("is-removing");

  requestAnimationFrame(() => {
    if (isListItem) {
      row.style.maxHeight = "0px";
      row.style.marginTop = "0px";
      row.style.marginBottom = "0px";
      row.style.paddingTop = "0px";
      row.style.paddingBottom = "0px";
    }
  });

  window.setTimeout(() => {
    row.remove();
    if (onDone) onDone();
  }, 240);
}

async function deleteFeedRequest(
  feedId: string,
  view: string,
): Promise<unknown> {
  const res = await fetch(
    "/admin/feeds/" +
      encodeURIComponent(feedId) +
      "/delete?view=" +
      encodeURIComponent(view),
    {
      method: "POST",
      headers: {
        Accept: "application/json",
      },
      credentials: "same-origin",
    },
  );
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const message =
      data && data.error
        ? String(data.error)
        : "Request failed (" + res.status + ")";
    throw new Error(message);
  }
  return data;
}

function refreshFeedRowCache(): void {
  FEED_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".feed-row"));
  FEED_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".feed-select"),
  );
  if (FEED_TOTAL_COUNT_EL) {
    FEED_TOTAL_COUNT_EL.textContent = String(FEED_ROWS.length);
  }
  updateFeedMatchCount();
  updateFeedSelectionState();
}

function setupFeedDeleteButtons(): void {
  const buttons = Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      'button[data-delete-kind="feed"]',
    ),
  );
  buttons.forEach((button) => {
    if (button.dataset.deleteReady === "true") return;
    button.dataset.deleteReady = "true";
    const original = (button.textContent || "").trim() || "Delete";
    button.dataset.originalLabel = original;

    let confirming = false;
    let confirmTimer = 0;
    let inFlight = false;

    const startConfirm = () => {
      confirming = true;
      button.classList.add("is-confirming");
      button.setAttribute("data-confirming", "true");
      button.innerHTML = DELETE_CONFIRM_LABEL;
      if (confirmTimer) window.clearTimeout(confirmTimer);
      confirmTimer = window.setTimeout(() => {
        confirming = false;
        resetDeleteButton(button);
      }, DELETE_CONFIRM_TIMEOUT_MS);
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
      setButtonLoading(button, true, DELETE_LOADING_LABEL);

      const toast = window.showToast
        ? window.showToast("Deleting feed...", {
            type: "info",
            loading: true,
            duration: 0,
          })
        : null;

      const feedId = button.getAttribute("data-feed-id") || "";
      const view = button.getAttribute("data-view") || getDeleteView();
      const row = button.closest<HTMLElement>(".feed-row");

      try {
        await deleteFeedRequest(feedId, view);

        if (toast && toast.update) {
          toast.update("Feed deleted.", {
            type: "success",
            loading: false,
            duration: 3200,
          });
        } else if (window.showToast) {
          window.showToast("Feed deleted.", { type: "success" });
        }

        animateRowRemoval(row, () => {
          refreshFeedRowCache();
        });
      } catch (error) {
        const errMsg =
          error instanceof Error && error.message
            ? error.message
            : "Unknown error";
        if (toast && toast.update) {
          toast.update("Delete failed: " + errMsg, {
            type: "error",
            loading: false,
          });
        } else if (window.showToast) {
          window.showToast("Delete failed: " + errMsg, { type: "error" });
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

    button.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Escape" && confirming && !inFlight) {
        confirming = false;
        if (confirmTimer) window.clearTimeout(confirmTimer);
        resetDeleteButton(button);
      }
    });
  });
}

function updateFeedSelectionState(): void {
  if (!FEED_CHECKBOXES.length) {
    return;
  }

  const selected = FEED_CHECKBOXES.filter((checkbox) => checkbox.checked);

  if (FEED_SELECTED_COUNT_EL) {
    FEED_SELECTED_COUNT_EL.textContent = selected.length + " selected";
  }
  if (FEED_BULK_DELETE_BUTTON_EL) {
    FEED_BULK_DELETE_BUTTON_EL.disabled = selected.length === 0;
  }
  if (FEED_SELECT_ALL_EL) {
    const visibleCheckboxes = FEED_CHECKBOXES.filter(
      (checkbox) => !(checkbox.closest("tr") as HTMLElement | null)?.hidden,
    );
    FEED_SELECT_ALL_EL.checked =
      visibleCheckboxes.length > 0 &&
      visibleCheckboxes.every((checkbox) => checkbox.checked);
  }
}

function toggleAllFeeds(checked: boolean): void {
  FEED_CHECKBOXES.forEach((checkbox) => {
    if (!(checkbox.closest("tr") as HTMLElement | null)?.hidden) {
      checkbox.checked = checked;
    }
  });
  updateFeedSelectionState();
}

function setVisibleFeedSelection(checked: boolean): void {
  FEED_CHECKBOXES.forEach((checkbox) => {
    if (!(checkbox.closest("tr") as HTMLElement | null)?.hidden) {
      checkbox.checked = checked;
    }
  });
  updateFeedSelectionState();
}

function selectMatchingFeeds(): void {
  setVisibleFeedSelection(true);
}

function clearFeedSelection(): void {
  FEED_CHECKBOXES.forEach((checkbox) => {
    checkbox.checked = false;
  });
  updateFeedSelectionState();
}

function filterFeedRows(): void {
  const query = (
    (document.getElementById("feed-search") as HTMLInputElement | null)
      ?.value || ""
  )
    .toLowerCase()
    .trim();
  FEED_ROWS.forEach((row) => {
    const haystack = row.getAttribute("data-search") || "";
    row.hidden = !!query && !haystack.includes(query);
  });
  updateFeedMatchCount();
  updateFeedSelectionState();
}

function confirmBulkFeedDelete(): boolean {
  const selected = FEED_CHECKBOXES.filter(
    (checkbox) => checkbox.checked,
  ).length;
  if (selected === 0) return false;

  const query = (
    (document.getElementById("feed-search") as HTMLInputElement | null)
      ?.value || ""
  ).trim();
  const extra =
    selected >= 50 && !query
      ? "\n\nThis is a large delete. Tip: use Search to narrow down spam first."
      : "";
  return confirm(
    "Delete " +
      selected +
      " selected feed(s)? This disables the feeds immediately. Stored emails are cleaned up best-effort and may take a while." +
      extra,
  );
}

function setButtonLoading(
  buttonEl: HTMLButtonElement | null,
  loading: boolean,
  label?: string,
): void {
  if (!buttonEl) return;
  if (loading) {
    if (!buttonEl.dataset.originalLabel) {
      buttonEl.dataset.originalLabel = (buttonEl.textContent || "").trim();
    }
    const text = label || "Working...";
    buttonEl.classList.add("is-loading");
    buttonEl.disabled = true;
    buttonEl.innerHTML =
      '<span class="spinner" aria-hidden="true"></span>' + text;
    return;
  }

  const original =
    buttonEl.dataset.originalLabel || (buttonEl.textContent || "").trim();
  buttonEl.classList.remove("is-loading");
  buttonEl.innerHTML = original;
}

function removeFeedRowsById(feedIds: string[]): void {
  const toRemove = new Set((feedIds || []).map((v) => String(v)));
  if (toRemove.size === 0) return;

  FEED_ROWS.forEach((row) => {
    const checkbox = row.querySelector<HTMLInputElement>("input.feed-select");
    const id = checkbox ? checkbox.value : "";
    if (toRemove.has(id)) {
      row.remove();
    }
  });

  FEED_ROWS = Array.from(document.querySelectorAll<HTMLElement>(".feed-row"));
  FEED_CHECKBOXES = Array.from(
    document.querySelectorAll<HTMLInputElement>(".feed-select"),
  );

  if (FEED_TOTAL_COUNT_EL) {
    FEED_TOTAL_COUNT_EL.textContent = String(FEED_ROWS.length);
  }
}

function onBulkFeedDeleteSubmit(event: Event): boolean {
  if (event && event.preventDefault) event.preventDefault();
  void bulkDeleteSelectedFeeds();
  return false;
}

async function bulkDeleteSelectedFeeds(): Promise<void> {
  if (FEED_BULK_DELETE_IN_PROGRESS) return;
  const selectedIds = FEED_CHECKBOXES.filter(
    (checkbox) => checkbox.checked,
  ).map((checkbox) => checkbox.value);
  if (selectedIds.length === 0) {
    if (window.showToast)
      window.showToast("No feeds selected.", { type: "info" });
    return;
  }
  if (!confirmBulkFeedDelete()) {
    return;
  }

  FEED_BULK_DELETE_IN_PROGRESS = true;
  setButtonLoading(FEED_BULK_DELETE_BUTTON_EL, true, "Deleting...");

  const toast = window.showToast
    ? window.showToast("Deleting " + selectedIds.length + " feed(s)...", {
        type: "info",
        loading: true,
        duration: 0,
      })
    : null;

  const batchSize = 10;
  let deletedTotal = 0;
  const failed: string[] = [];

  try {
    for (let i = 0; i < selectedIds.length; i += batchSize) {
      const batch = selectedIds.slice(i, i + batchSize);
      const res = await fetch("/admin/feeds/bulk-delete", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        credentials: "same-origin",
        body: JSON.stringify({ feedIds: batch }),
      });

      let data: Record<string, unknown> = {};
      if (window.parseJsonResponseOrThrow) {
        data = await window.parseJsonResponseOrThrow(res, {
          prefix: "Bulk feed delete failed",
        });
      } else {
        data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
        if (!res.ok) {
          const message =
            data && data.error
              ? String(data.error)
              : "Bulk feed delete failed (HTTP " + res.status + ")";
          throw new Error(message);
        }
      }

      const deletedIds = Array.isArray(data.deletedFeedIds)
        ? (data.deletedFeedIds as string[])
        : batch;
      const failedIds = Array.isArray(data.failedFeedIds)
        ? (data.failedFeedIds as string[])
        : [];
      const failureDetails = Array.isArray(data.failures)
        ? (data.failures as Array<Record<string, unknown>>)
        : [];

      removeFeedRowsById(deletedIds);
      deletedTotal += deletedIds.length;

      if (toast && toast.update) {
        const done = Math.min(i + batch.length, selectedIds.length);
        toast.update(
          "Deleting... (" + done + " of " + selectedIds.length + ")",
          { type: "info" },
        );
      }

      // Keep selection state consistent as rows disappear.
      updateFeedMatchCount();
      updateFeedSelectionState();

      // If a batch fails for some feeds, retry those one-by-one using the bulk-delete
      // endpoint with a single id (keeps semantics consistent and avoids hiding active feeds).
      if (failedIds.length > 0) {
        if (toast && toast.update) {
          toast.update(
            "Retrying " + failedIds.length + " failed feed(s) one-by-one...",
            { type: "info" },
          );
        }

        const stillFailed: string[] = [];
        for (let j = 0; j < failedIds.length; j++) {
          const feedId = String(failedIds[j] || "");
          if (!feedId) continue;
          try {
            const retryRes = await fetch("/admin/feeds/bulk-delete", {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Accept: "application/json",
              },
              credentials: "same-origin",
              body: JSON.stringify({ feedIds: [feedId] }),
            });

            let retryData: Record<string, unknown> = {};
            if (window.parseJsonResponseOrThrow) {
              retryData = await window.parseJsonResponseOrThrow(retryRes, {
                prefix: "Retry delete failed",
              });
            } else {
              retryData = (await retryRes.json().catch(() => ({}))) as Record<
                string,
                unknown
              >;
              if (!retryRes.ok) {
                const message =
                  retryData && retryData.error
                    ? String(retryData.error)
                    : "Retry delete failed (HTTP " + retryRes.status + ")";
                throw new Error(message);
              }
            }

            const retryDeleted = Array.isArray(retryData.deletedFeedIds)
              ? (retryData.deletedFeedIds as string[])
              : [];
            const retryFailed = Array.isArray(retryData.failedFeedIds)
              ? (retryData.failedFeedIds as string[])
              : [];

            if (retryDeleted.includes(feedId)) {
              removeFeedRowsById([feedId]);
              deletedTotal += 1;
            } else if (retryFailed.includes(feedId)) {
              stillFailed.push(feedId);
            } else {
              stillFailed.push(feedId);
            }
          } catch {
            stillFailed.push(feedId);
          }

          if (toast && toast.update) {
            toast.update(
              "Retrying... (" + (j + 1) + " of " + failedIds.length + ")",
              { type: "info" },
            );
          }
        }

        // Replace failed ids from this batch with only the ones that still failed after retry.
        if (stillFailed.length > 0) {
          failed.push(...stillFailed);
          if (window.showToast && failureDetails.length > 0) {
            const first =
              failureDetails[0] && failureDetails[0].error
                ? String(failureDetails[0].error)
                : "";
            if (first) {
              window.showToast("Some feeds failed to delete: " + first, {
                type: "error",
              });
            }
          }
        }

        updateFeedMatchCount();
        updateFeedSelectionState();
      }
    }

    if (toast && toast.dismiss) toast.dismiss();
    const uniqueFailed = Array.from(
      new Set(failed.map((v) => String(v)).filter(Boolean)),
    );
    if (uniqueFailed.length > 0) {
      if (window.showToast) {
        window.showToast(
          "Deleted " +
            deletedTotal +
            " feed(s). " +
            uniqueFailed.length +
            " failed (still visible).",
          { type: "error" },
        );
      }
    } else {
      if (window.showToast)
        window.showToast("Deleted " + deletedTotal + " feed(s).", {
          type: "success",
        });
    }
  } catch (error) {
    if (toast && toast.dismiss) toast.dismiss();
    if (window.showToast) {
      window.showToast(
        error instanceof Error && error.message
          ? error.message
          : "Bulk feed delete failed.",
        { type: "error" },
      );
    }
  } finally {
    FEED_BULK_DELETE_IN_PROGRESS = false;
    setButtonLoading(FEED_BULK_DELETE_BUTTON_EL, false);
    updateFeedSelectionState();
  }
}

// Expose functions needed by inline HTML event handlers
(window as unknown as Record<string, unknown>).scheduleFeedFilter =
  scheduleFeedFilter;
(window as unknown as Record<string, unknown>).toggleAllFeeds = toggleAllFeeds;
(window as unknown as Record<string, unknown>).selectMatchingFeeds =
  selectMatchingFeeds;
(window as unknown as Record<string, unknown>).clearFeedSelection =
  clearFeedSelection;
(window as unknown as Record<string, unknown>).onBulkFeedDeleteSubmit =
  onBulkFeedDeleteSubmit;

document.addEventListener("DOMContentLoaded", () => {
  initFeedUI();
});
