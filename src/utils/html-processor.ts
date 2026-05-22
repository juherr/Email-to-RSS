import { parseHTML } from "linkedom";
import escapeHtml from "escape-html";

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
 */
export function processEmailContent(content: string): string {
  if (!content) return "";

  if (isPlainText(content)) {
    return `<pre style="white-space: pre-wrap; word-break: break-word;">${escapeHtml(content)}</pre>`;
  }

  const { document } = parseHTML(content);

  document
    .querySelectorAll("script, object, embed, iframe, frame, frameset")
    .forEach((el: Element) => el.remove());

  document.querySelectorAll("*").forEach((el: Element) => sanitizeElement(el));

  const body = document.querySelector("body");
  return body ? body.innerHTML : content;
}
