import { describe, it, expect } from "vitest";
import { Lifetime } from "./lifetime";

const NOW = 1_000_000;
const HOUR = 3_600_000;

describe("Lifetime", () => {
  it("resolves a positive lifetime to an absolute expiry", () => {
    expect(Lifetime.ofHours(2).resolveExpiry(NOW)).toBe(NOW + 2 * HOUR);
  });

  it("never expires for Lifetime.never", () => {
    expect(Lifetime.never.resolveExpiry(NOW)).toBeUndefined();
  });

  it("treats non-positive or non-finite hours as no expiry", () => {
    expect(Lifetime.ofHours(0).resolveExpiry(NOW)).toBeUndefined();
    expect(Lifetime.ofHours(-5).resolveExpiry(NOW)).toBeUndefined();
    expect(Lifetime.ofHours(NaN).resolveExpiry(NOW)).toBeUndefined();
    expect(Lifetime.ofHours(Infinity).resolveExpiry(NOW)).toBeUndefined();
  });
});
