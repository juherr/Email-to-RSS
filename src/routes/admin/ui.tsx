import variablesCss from "../../styles/variables.css";
import layoutCss from "../../styles/layout.css";
import componentsCss from "../../styles/components.css";
import utilitiesCss from "../../styles/utilities.css";
import { interactiveScripts } from "../../scripts/index";
import { APP_VERSION } from "../../config/version";
import { FAVICON_PATH } from "../favicon";
import { Env } from "../../types";
import type { NativeFeed } from "../../types";
import {
  feedFormatUrl,
  feedValidatorUrl,
  type FeedFormat,
} from "../../infrastructure/urls";

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
          <span class="site-footer-sep" aria-hidden="true">
            ·
          </span>
          <span class="site-footer-version">v{APP_VERSION}</span>
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

// ── Shared SVG icons ──────────────────────────────────────────────────────────

export const CopyIcon = () => (
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

export const CheckIcon = () => (
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

const OpenIcon = () => (
  <svg
    class="chip-icon"
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
    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
    <polyline points="15 3 21 3 21 9"></polyline>
    <line x1="10" y1="14" x2="21" y2="3"></line>
  </svg>
);

const ValidateIcon = () => (
  <svg
    class="chip-icon"
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
    <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
    <polyline points="22 4 12 14.01 9 11.01"></polyline>
  </svg>
);

// ── Feed format chips ("Subscribe" block) ─────────────────────────────────────

const FORMAT_LABELS: Record<FeedFormat, string> = {
  rss: "RSS",
  atom: "Atom",
  json: "JSON",
};

// One copyable feed chip: copy + open, plus an optional validate action.
// Shared by the KTN "Subscribe" formats and the detected native feeds, so the
// copy-script markup (`copyable-value`/`data-copy`) stays identical in one place.
const FeedChip = ({
  label,
  format,
  url,
  validateUrl,
}: {
  label: string;
  format: FeedFormat;
  url: string;
  validateUrl?: string;
}) => (
  <div class="format-chip" data-format={format}>
    <span class="format-chip-label">{label}</span>
    <span class="format-chip-actions">
      <span class="copyable copyable-chip">
        <span
          class="copyable-content"
          title={`Copy ${label} feed URL`}
          aria-label={`Copy ${label} feed URL`}
        >
          <span class="copyable-value" data-copy={url} hidden></span>
          <span class="copy-icon-container">
            <CopyIcon />
            <CheckIcon />
          </span>
        </span>
      </span>
      <a
        class="chip-action"
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        title={`Open ${label} feed in a new tab`}
        aria-label={`Open ${label} feed in a new tab`}
      >
        <OpenIcon />
      </a>
      {validateUrl && (
        <a
          class="chip-action"
          href={validateUrl}
          target="_blank"
          rel="noopener noreferrer"
          title={`Validate ${label} feed`}
          aria-label={`Validate ${label} feed`}
        >
          <ValidateIcon />
        </a>
      )}
    </span>
  </div>
);

const FormatChip = ({
  format,
  feedId,
  env,
}: {
  format: FeedFormat;
  feedId: string;
  env: Env;
}) => (
  <FeedChip
    label={FORMAT_LABELS[format]}
    format={format}
    url={feedFormatUrl(format, feedId, env)}
    validateUrl={feedValidatorUrl(format, feedId, env)}
  />
);

export const FeedFormats = ({
  feedId,
  env,
  compact,
}: {
  feedId: string;
  env: Env;
  compact?: boolean;
}) => (
  <div class={`feed-formats${compact ? " feed-formats-compact" : ""}`}>
    {!compact && <span class="feed-formats-label">Subscribe</span>}
    <div class="feed-formats-chips">
      <FormatChip format="rss" feedId={feedId} env={env} />
      <FormatChip format="atom" feedId={feedId} env={env} />
      <FormatChip format="json" feedId={feedId} env={env} />
    </div>
  </div>
);

// ── Native feed chips ─────────────────────────────────────────────────────────

export const NativeFeeds = ({ feeds }: { feeds: NativeFeed[] }) => {
  if (feeds.length === 0) return null;
  return (
    <div class="feed-formats native-feeds">
      <span class="feed-formats-label">Native feeds</span>
      <div class="feed-formats-chips">
        {feeds.map((feed) => (
          <FeedChip
            key={feed.url}
            label={FORMAT_LABELS[feed.type]}
            format={feed.type}
            url={feed.url}
          />
        ))}
      </div>
    </div>
  );
};

// ── Expiry pill ───────────────────────────────────────────────────────────────

function formatExpiry(expiresAt: number): { label: string; expired: boolean } {
  const remaining = expiresAt - Date.now();
  if (remaining <= 0) {
    const h = Math.floor(-remaining / 3_600_000);
    return {
      label: h > 0 ? `Expired ${h}h ago` : "Just expired",
      expired: true,
    };
  }
  const h = Math.floor(remaining / 3_600_000);
  if (h >= 48) {
    return { label: `Expires in ${Math.floor(h / 24)}d`, expired: false };
  }
  const m = Math.floor((remaining % 3_600_000) / 60_000);
  return {
    label: h > 0 ? `Expires in ${h}h ${m}m` : `Expires in ${m}m`,
    expired: false,
  };
}

export const ExpiryBadge = ({ expiresAt }: { expiresAt: number }) => {
  const { label, expired } = formatExpiry(expiresAt);
  return (
    <span class={`pill ${expired ? "pill-expired" : "pill-expiry"}`}>
      {label}
    </span>
  );
};
