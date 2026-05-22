import { html, raw } from "hono/html";
import { designSystem } from "../../styles/index";
import { interactiveScripts } from "../../scripts/index";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const layout = (title: string, content: any) => {
  return html`<!DOCTYPE html>
    <html>
      <head>
        <title>${title} - Email to RSS Admin</title>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="light dark" />
        <style>
          ${raw(designSystem)}
        </style>
        <script>
          ${raw(interactiveScripts)};
        </script>
      </head>
      <body class="page">
        ${content}
      </body>
    </html>`;
};

export function clampText(value: string, maxLen: number): string {
  const raw = `${value || ""}`;
  if (raw.length <= maxLen) {
    return raw.trim();
  }
  if (maxLen <= 3) {
    return raw.slice(0, maxLen).trim();
  }
  return `${raw.slice(0, maxLen - 3).trimEnd()}...`;
}
