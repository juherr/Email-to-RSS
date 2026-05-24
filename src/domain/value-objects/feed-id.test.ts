import { describe, it, expect } from "vitest";
import { FeedId } from "./feed-id";

describe("FeedId.generate", () => {
  it("produces an opaque base64url token", () => {
    for (let i = 0; i < 50; i++) {
      expect(FeedId.generate().value).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
  });

  it("is unguessable: 50 ids are all distinct", () => {
    const ids = new Set(
      Array.from({ length: 50 }, () => FeedId.generate().value),
    );
    expect(ids.size).toBe(50);
  });

  it("does not produce the legacy noun.noun.NN format", () => {
    expect(FeedId.generate().value).not.toMatch(/^[a-z]+\.[a-z]+\.\d{2}$/);
  });
});

describe("FeedId.unchecked", () => {
  it("wraps a value without validation", () => {
    expect(FeedId.unchecked("anything").value).toBe("anything");
  });
});
