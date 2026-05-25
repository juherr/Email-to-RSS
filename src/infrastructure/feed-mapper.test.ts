import { describe, it, expect } from "vitest";
import { fromConfigDTO, toConfigDTO, toListItemDTO } from "./feed-mapper";
import { FeedId } from "../domain/value-objects/feed-id";
import type { FeedConfig } from "../types";

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

  it("projects the feeds:list item from domain state", () => {
    const item = toListItemDTO(
      FeedId.unchecked("a.b.42"),
      fromConfigDTO(fullConfig),
    );
    expect(item).toEqual({
      id: "a.b.42",
      title: "News",
      description: "desc",
      mailbox_id: "a.b.42",
      expires_at: 3000,
      pendingConfirmation: false,
    });
  });
});
