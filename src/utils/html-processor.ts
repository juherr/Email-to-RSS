import { parseHTML } from "linkedom";
import escapeHtml from "escape-html";
import type { AttachmentData } from "../types";

// Strip surrounding angle brackets and whitespace from a Content-ID so that a
// stored value like "<ii_mpi85rqy0>" matches an HTML reference "cid:ii_mpi85rqy0".
export function normalizeCid(
  cid: string | null | undefined,
): string | undefined {
  if (!cid) return undefined;
  const trimmed = cid.trim().replace(/^<|>$/g, "").trim();
  return trimmed || undefined;
}

function cleanMsoStyles(style: string): string {
  return style
    .split(";")
    .map((p) => p.trim())
    .filter((p) => p && !/^mso-/i.test(p))
    .join("; ");
}

function isPlainText(content: string): boolean {
  return !/<[a-z][\s\S]*>/i.test(content);
}

function rewriteCidSrc(
  el: Element,
  cidMap: Map<string, AttachmentData>,
  baseUrl: string,
): void {
  const src = el.getAttribute("src") ?? "";
  const match = src.match(/^\s*cid:(.+)$/i);
  if (!match) return;
  const attachment = cidMap.get(normalizeCid(match[1]) ?? "");
  if (!attachment) return;
  el.setAttribute(
    "src",
    `${baseUrl}/files/${attachment.id}/${encodeURIComponent(attachment.filename)}`,
  );
}

function sanitizeElement(el: Element): void {
  // Snapshot attribute names before mutating (linkedom attributes is array-like)
  const attrs = Array.from(
    el.attributes as unknown as ArrayLike<{ name: string }>,
  ).map((a) => a.name);
  for (const attr of attrs) {
    // Remove event handlers (onclick, onerror, onload, …)
    if (/^on/i.test(attr)) {
      el.removeAttribute(attr);
      continue;
    }
    // Remove javascript: URLs
    if (["href", "src", "action"].includes(attr.toLowerCase())) {
      const val = el.getAttribute(attr) ?? "";
      if (/^\s*javascript:/i.test(val)) {
        el.removeAttribute(attr);
        continue;
      }
    }
  }
  // Strip mso-* inline style properties (Office HTML noise)
  const style = el.getAttribute("style");
  if (style !== null) {
    const cleaned = cleanMsoStyles(style);
    if (cleaned) {
      el.setAttribute("style", cleaned);
    } else {
      el.removeAttribute("style");
    }
  }
}

/**
 * Processes email content for safe display in feeds and entry pages:
 * - Detects plain text and wraps it in a <pre> block
 * - Extracts the <body> fragment from full HTML documents
 * - Removes dangerous elements: <script>, <iframe>, <object>, <embed>
 * - Removes event handler attributes and javascript: URLs
 * - Strips mso-* inline style properties (Office HTML)
 * - Rewrites inline cid: image refs to the stored attachment URL. baseUrl=""
 *   yields relative URLs (entry page, same origin); a baseUrl yields absolute
 *   URLs (feeds, for external RSS readers).
 */
export function processEmailContent(
  content: string,
  attachments?: AttachmentData[],
  baseUrl = "",
): string {
  if (!content) return "";

  if (isPlainText(content)) {
    return `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(content)}</pre>`;
  }

  const cidMap = new Map<string, AttachmentData>();
  for (const att of attachments ?? []) {
    const cid = normalizeCid(att.contentId);
    if (cid) cidMap.set(cid, att);
  }

  const { document } = parseHTML(content);

  document
    .querySelectorAll("script, object, embed, iframe, frame, frameset")
    .forEach((el: Element) => el.remove());

  document.querySelectorAll("*").forEach((el: Element) => sanitizeElement(el));

  if (cidMap.size > 0) {
    document
      .querySelectorAll("[src]")
      .forEach((el: Element) => rewriteCidSrc(el, cidMap, baseUrl));
  }

  // Full documents expose a <body>; bodyless fragments are serialized directly
  // so that sanitization and cid rewriting still apply to their nodes.
  const body = document.querySelector("body");
  return body ? body.innerHTML : document.toString();
}
