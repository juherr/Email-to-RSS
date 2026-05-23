import { describe, it, expect } from "vitest";
import { Domain } from "./domain";

describe("Domain", () => {
  it("normalises case and whitespace", () => {
    expect(Domain.parse("  Example.COM ")?.value).toBe("example.com");
  });

  it("strips a leading @ and trailing dots", () => {
    expect(Domain.parse("@example.com")?.value).toBe("example.com");
    expect(Domain.parse("example.com.")?.value).toBe("example.com");
  });

  it("returns null for empty input", () => {
    expect(Domain.parse("")).toBeNull();
    expect(Domain.parse("@")).toBeNull();
  });

  it("compares by normalised value", () => {
    expect(
      Domain.parse("Example.com")!.matches(Domain.parse("example.com")!),
    ).toBe(true);
    expect(Domain.parse("a.com")!.matches(Domain.parse("b.com")!)).toBe(false);
  });
});
