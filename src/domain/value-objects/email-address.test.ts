import { describe, it, expect } from "vitest";
import { EmailAddress } from "./email-address";

describe("EmailAddress", () => {
  it("parses a bare address and normalises it", () => {
    const email = EmailAddress.parse("News@Example.COM")!;
    expect(email.normalized).toBe("news@example.com");
    expect(email.domain.value).toBe("example.com");
  });

  it("parses a display form (Name <addr>)", () => {
    const email = EmailAddress.parse("GitHub <news@GitHub.com>")!;
    expect(email.normalized).toBe("news@github.com");
    expect(email.domain.value).toBe("github.com");
  });

  it("strips a trailing dot from the domain", () => {
    expect(EmailAddress.parse("a@Example.COM.")?.domain.value).toBe(
      "example.com",
    );
  });

  it("returns null when there is no address", () => {
    expect(EmailAddress.parse("not an email")).toBeNull();
    expect(EmailAddress.parse("")).toBeNull();
  });
});
