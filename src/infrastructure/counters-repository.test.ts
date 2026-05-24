import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { CountersRepository } from "./counters-repository";
import type { Env } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;

describe("CountersRepository", () => {
  it("round-trips the counters singleton", async () => {
    const repo = new CountersRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.getRaw()).toBeNull();
    await repo.put({
      feeds_created: 1,
      feeds_deleted: 0,
      emails_received: 2,
      emails_rejected: 0,
      emails_forwarded: 0,
      unsubscribes_sent: 0,
    });
    expect(await repo.getRaw()).toMatchObject({ emails_received: 2 });
  });
});
