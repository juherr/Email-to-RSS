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

  it("derives the sender site base URL from the domain", () => {
    expect(EmailAddress.parse("News <a@Example.com>")?.siteBaseUrl()).toBe(
      "https://example.com/",
    );
  });

  it("captures the display name verbatim from a display form", () => {
    const email = EmailAddress.parse("Alice B <Alice@Example.com>")!;
    expect(email.displayName).toBe("Alice B");
    expect(email.label()).toBe("Alice B");
  });

  it("has no display name for a bare address and labels by the address", () => {
    const email = EmailAddress.parse("Bob@Example.com")!;
    expect(email.displayName).toBeUndefined();
    expect(email.label()).toBe("bob@example.com");
  });

  it("falls back to the address as the label when the display name is empty", () => {
    expect(EmailAddress.parse("<a@b.com>")?.label()).toBe("a@b.com");
  });
});
