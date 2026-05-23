import { Context } from "hono";
import { Env } from "../types";
import { getStats } from "../utils/stats";
import { Layout } from "./admin/ui";

function formatDateTime(iso?: string): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never";
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d+Z$/, " UTC");
}

function formatRelative(iso?: string): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "just now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function formatUptime(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 0) return "—";
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? "hour" : "hours"}`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"}`;
}

type Tone = "success" | "danger";

type StatProps = {
  label: string;
  value: string | number;
  tone?: Tone;
  title?: string;
  time?: boolean;
};

const Stat = ({ label, value, tone, title, time }: StatProps) => {
  const valueClass = [
    "stat-value",
    time ? "stat-value-time" : "",
    tone ? `stat-value-${tone}` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <div class="card stat-card" title={title}>
      <span class={valueClass}>{value}</span>
      <span class="stat-label">{label}</span>
    </div>
  );
};

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  const stats = await getStats(c.env);

  const netFeeds = stats.feeds_created - stats.feeds_deleted;
  const totalEmails = stats.emails_received + stats.emails_rejected;
  const acceptanceRate =
    totalEmails > 0
      ? `${Math.round((stats.emails_received / totalEmails) * 100)}%`
      : "—";
  const avgEmailsPerFeed =
    stats.feeds_created > 0
      ? (stats.emails_received / stats.feeds_created).toFixed(1)
      : "—";

  return c.html(
    <Layout title="Status" label="status">
      <div class="container fade-in">
        <div class="header-with-actions">
          <div class="header-title">
            <h1>kill-the-news</h1>
            <p>Instance status &amp; monitoring</p>
          </div>
          <div class="header-actions">
            <a href="/admin" class="button">
              Go to admin
            </a>
          </div>
        </div>

        <div class="card stat-hero">
          <div class="stat-hero-main">
            <span class="stat-hero-value">{stats.active_feeds}</span>
            <span class="stat-hero-label">Active feeds</span>
          </div>
          <div class="stat-hero-aside">
            <span class="stat-hero-aside-value">{stats.emails_received}</span>
            <span class="stat-hero-aside-label">Emails received</span>
          </div>
        </div>

        <section class="stat-section">
          <h2 class="stat-section-title">Feeds</h2>
          <div class="stats-grid">
            <Stat label="Feeds created" value={stats.feeds_created} />
            <Stat
              label="Feeds deleted"
              value={stats.feeds_deleted}
              tone="danger"
            />
            <Stat label="Net feeds" value={netFeeds} />
            <Stat label="Unsubscribes sent" value={stats.unsubscribes_sent} />
            <Stat
              label="Last feed created"
              value={formatRelative(stats.last_feed_created_at)}
              title={formatDateTime(stats.last_feed_created_at)}
              time
            />
          </div>
        </section>

        <section class="stat-section">
          <h2 class="stat-section-title">Emails</h2>
          <div class="stats-grid">
            <Stat
              label="Emails received"
              value={stats.emails_received}
              tone="success"
            />
            <Stat
              label="Emails rejected"
              value={stats.emails_rejected}
              tone="danger"
            />
            <Stat
              label="Acceptance rate"
              value={acceptanceRate}
              tone="success"
            />
            <Stat label="Avg emails / feed" value={avgEmailsPerFeed} />
            <Stat
              label="Last email"
              value={formatRelative(stats.last_email_at)}
              title={formatDateTime(stats.last_email_at)}
              time
            />
          </div>
        </section>

        <section class="stat-section">
          <h2 class="stat-section-title">Distribution</h2>
          <div class="stats-grid">
            <Stat
              label="WebSub subscribers"
              value={stats.websub_subscriptions_active}
            />
          </div>
        </section>

        <section class="stat-section">
          <h2 class="stat-section-title">Instance</h2>
          <div class="stats-grid">
            <Stat label="Uptime" value={formatUptime(stats.first_seen)} time />
            <Stat
              label="Online since"
              value={formatRelative(stats.first_seen)}
              title={formatDateTime(stats.first_seen)}
              time
            />
          </div>
        </section>
      </div>
    </Layout>,
  );
}
