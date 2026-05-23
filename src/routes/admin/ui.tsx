import variablesCss from "../../styles/variables.css";
import layoutCss from "../../styles/layout.css";
import componentsCss from "../../styles/components.css";
import utilitiesCss from "../../styles/utilities.css";
import { interactiveScripts } from "../../scripts/index";
import { FAVICON_PATH } from "../favicon";

const designSystem = [
  variablesCss,
  layoutCss,
  componentsCss,
  utilitiesCss,
].join("\n");

type LayoutProps = {
  title: string;
  label?: string;
  children: import("hono/jsx").Child;
};

export const Layout = ({ title, label = "admin", children }: LayoutProps) => {
  return (
    <html>
      <head>
        <title>{title} — kill-the-news</title>
        <link rel="icon" type="image/svg+xml" href={FAVICON_PATH} />
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <meta name="color-scheme" content="dark light" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossorigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
        {/* designSystem and interactiveScripts are static trusted strings, not user input */}
        <style dangerouslySetInnerHTML={{ __html: designSystem }} />
        <script
          dangerouslySetInnerHTML={{ __html: interactiveScripts + ";" }}
        />
      </head>
      <body class="page">
        <header class="site-header">
          <a
            href="https://kill-the.news/"
            class="site-header-logo"
            target="_blank"
            rel="noopener"
          >
            kill-the-news
          </a>
          <span class="site-header-label">{label}</span>
        </header>
        {children}
        <footer class="site-footer">
          <a href="https://kill-the.news/" target="_blank" rel="noopener">
            kill-the.news
          </a>
          <span class="site-footer-sep" aria-hidden="true">
            ·
          </span>
          <a
            href="https://github.com/sponsors/juherr"
            target="_blank"
            rel="noopener"
            class="site-footer-sponsor"
          >
            ♥ Sponsor
          </a>
        </footer>
      </body>
    </html>
  );
};

export { Layout as layout };

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
