import { describe, it, expect } from "vitest";
import { fromConfigDTO, toConfigDTO, toListItemDTO } from "./feed-mapper";
import { FeedId } from "../domain/value-objects/feed-id";
import { Feed } from "../domain/feed.aggregate";
import type { FeedConfig, FeedMetadata } from "../types";

const fullConfig: FeedConfig = {
  title: "News",
  description: "desc",
  language: "en",
  mailbox_id: "a.b.42",
  author: "Jane",
  allowed_senders: ["a@x.com"],
  blocked_senders: ["b@y.com"],
  created_at: 1000,
  updated_at: 2000,
  expires_at: 3000,
};

const feedFrom = (metadata: FeedMetadata) =>
  Feed.reconstitute(
    FeedId.unchecked("a.b.42"),
    fromConfigDTO(fullConfig),
    metadata,
  );

describe("feed-mapper", () => {
  it("round-trips a full config DTO through domain state unchanged", () => {
    expect(toConfigDTO(fromConfigDTO(fullConfig))).toEqual(fullConfig);
  });

  it("defaults absent sender lists to empty arrays on the domain side", () => {
    const state = fromConfigDTO({
      title: "T",
      language: "en",
      mailbox_id: "t.t.42",
      created_at: 1,
    });
    expect(state.allowedSenders).toEqual([]);
    expect(state.blockedSenders).toEqual([]);
  });

  it("projects the feeds:list item from an empty feed aggregate", () => {
    const item = toListItemDTO(feedFrom({ emails: [] }));
    expect(item).toEqual({
      id: "a.b.42",
      title: "News",
      description: "desc",
      mailbox_id: "a.b.42",
      expires_at: 3000,
      pendingConfirmation: false,
      hasNativeFeed: false,
      emailCount: 0,
      lastEmailAt: undefined,
    });
  });

  it("projects pendingConfirmation and hasNativeFeed from metadata", () => {
    const item = toListItemDTO(
      feedFrom({
        emails: [],
        pendingConfirmation: true,
        nativeFeeds: { "n@x.com": [{ url: "https://x/rss", type: "rss" }] },
      }),
    );
    expect(item.pendingConfirmation).toBe(true);
    expect(item.hasNativeFeed).toBe(true);
  });

  it("projects email count and the newest email's timestamp", () => {
    const item = toListItemDTO(
      feedFrom({
        emails: [
          { key: "k2", subject: "b", receivedAt: 1700000000000 },
          { key: "k1", subject: "a", receivedAt: 1600000000000 },
        ],
      }),
    );
    expect(item.emailCount).toBe(2);
    expect(item.lastEmailAt).toBe(1700000000000);
  });
});
