import { describe, it, expect } from "vitest";
import { FeedId } from "./feed-id";

describe("FeedId.parse", () => {
  it("extracts the feed id from an inbound address", () => {
    expect(FeedId.parse("river.castle.42@example.com")?.value).toBe(
      "river.castle.42",
    );
  });

  it("preserves the original casing of the local part", () => {
    expect(FeedId.parse("River.Castle.42@example.com")?.value).toBe(
      "River.Castle.42",
    );
  });

  it("rejects malformed feed ids", () => {
    expect(FeedId.parse("user@example.com")).toBeNull();
    expect(FeedId.parse("notanemail")).toBeNull();
    expect(FeedId.parse("river.castle.4@example.com")).toBeNull();
    expect(FeedId.parse("river.castle.123@example.com")).toBeNull();
  });
});

describe("FeedId.generate", () => {
  it("produces the noun.noun.NN format", () => {
    for (let i = 0; i < 50; i++) {
      expect(FeedId.generate().value).toMatch(/^[a-z]+\.[a-z]+\.\d{2}$/);
    }
  });

  it("round-trips through parse from an address", () => {
    const id = FeedId.generate();
    expect(FeedId.parse(`${id.value}@example.com`)?.value).toBe(id.value);
  });
});
