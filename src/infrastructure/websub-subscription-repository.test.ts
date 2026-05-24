import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { WebSubSubscriptionRepository } from "./websub-subscription-repository";
import { FeedId } from "../domain/value-objects/feed-id";
import type { Env, WebSubSubscription } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;
const fid = FeedId.unchecked("a.b.42");

describe("WebSubSubscriptionRepository", () => {
  it("round-trips subscriptions and counts feeds with subscribers", async () => {
    const repo = new WebSubSubscriptionRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.get(fid)).toEqual([]);
    const subs: WebSubSubscription[] = [
      { callbackUrl: "https://r.example/cb", expiresAt: 9999 },
    ];
    await repo.save(fid, subs);
    expect(await repo.get(fid)).toEqual(subs);
    expect(await repo.countKeys()).toBe(1);
  });
});
