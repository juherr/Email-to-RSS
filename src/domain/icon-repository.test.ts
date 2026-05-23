import { describe, it, expect } from "vitest";
import { createMockEnv } from "../test/setup";
import { IconRepository } from "./icon-repository";
import type { Env } from "../types";

const mockEnv = () => createMockEnv() as unknown as Env;

describe("IconRepository", () => {
  it("stores and reads favicons as text or json under the icon: key", async () => {
    const repo = new IconRepository(mockEnv().EMAIL_STORAGE);
    expect(await repo.getText("example.com")).toBeNull();
    await repo.put("example.com", JSON.stringify({ data: null }), 60);
    expect(await repo.getText("example.com")).toBe('{"data":null}');
    expect(await repo.getJson<{ data: null }>("example.com")).toEqual({
      data: null,
    });
  });
});
