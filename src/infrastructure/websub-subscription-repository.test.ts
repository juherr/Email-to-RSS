import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { WebSubSubscriptionRepository } from "./websub-subscription-repository";
import type { Env, WebSubSubscription } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;

describe("WebSubSubscriptionRepository", () => {
  it("round-trips subscriptions and counts feeds with subscribers", async () => {
    const repo = new WebSubSubscriptionRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.get("a.b.42")).toEqual([]);
    const subs: WebSubSubscription[] = [
      { callbackUrl: "https://r.example/cb", expiresAt: 9999 },
    ];
    await repo.save("a.b.42", subs);
    expect(await repo.get("a.b.42")).toEqual(subs);
    expect(await repo.countKeys()).toBe(1);
  });
});
