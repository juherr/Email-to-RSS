import { describe, it, expect } from "vitest";
import { isExpired } from "./feed";

describe("isExpired", () => {
  it("is false when no expiry is set", () => {
    expect(isExpired({ expires_at: undefined }, 1000)).toBe(false);
  });

  it("is true at or past the expiry instant", () => {
    expect(isExpired({ expires_at: 1000 }, 1000)).toBe(true);
    expect(isExpired({ expires_at: 1000 }, 1001)).toBe(true);
    expect(isExpired({ expires_at: 1000 }, 999)).toBe(false);
  });
});
