import { Context } from "hono";
import { Env } from "../types";
import { getStats } from "../utils/stats";
import { Layout } from "./admin/ui";

function formatDateTime(iso?: string): string {
  if (!iso) return "Never";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "Never";
  return date.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

export async function handle(c: Context<{ Bindings: Env }>): Promise<Response> {
  const stats = await getStats(c.env);

  const cards: Array<{ label: string; value: string | number; time?: boolean }> =
    [
      { label: "Active feeds", value: stats.active_feeds },
      { label: "Feeds created", value: stats.feeds_created },
      { label: "Feeds deleted", value: stats.feeds_deleted },
      { label: "Emails received", value: stats.emails_received },
      { label: "Emails rejected", value: stats.emails_rejected },
      { label: "WebSub subscribers", value: stats.websub_subscriptions_active },
      { label: "Last email", value: formatDateTime(stats.last_email_at), time: true },
      { label: "Last feed created", value: formatDateTime(stats.last_feed_created_at), time: true },
      { label: "Online since", value: formatDateTime(stats.first_seen), time: true },
    ];

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

        <div class="stats-grid">
          {cards.map((card) => (
            <div class="card stat-card">
              <span class={`stat-value${card.time ? " stat-value-time" : ""}`}>
                {card.value}
              </span>
              <span class="stat-label">{card.label}</span>
            </div>
          ))}
        </div>
      </div>
    </Layout>,
  );
}
