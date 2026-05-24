import { describe, it, expect } from "vitest";
import { MailboxId } from "./mailbox-id";

describe("MailboxId.parse", () => {
  it("extracts the mailbox id from an inbound address", () => {
    expect(MailboxId.parse("river.castle.42@example.com")?.value).toBe(
      "river.castle.42",
    );
  });

  it("preserves the original casing of the local part", () => {
    expect(MailboxId.parse("River.Castle.42@example.com")?.value).toBe(
      "River.Castle.42",
    );
  });

  it("rejects malformed mailbox ids", () => {
    expect(MailboxId.parse("user@example.com")).toBeNull();
    expect(MailboxId.parse("notanemail")).toBeNull();
    expect(MailboxId.parse("river.castle.4@example.com")).toBeNull();
    expect(MailboxId.parse("river.castle.123@example.com")).toBeNull();
  });
});

describe("MailboxId.generate", () => {
  it("produces the noun.noun.NN format", () => {
    for (let i = 0; i < 50; i++) {
      expect(MailboxId.generate().value).toMatch(/^[a-z]+\.[a-z]+\.\d{2}$/);
    }
  });

  it("round-trips through parse from an address", () => {
    const id = MailboxId.generate();
    expect(MailboxId.parse(`${id.value}@example.com`)?.value).toBe(id.value);
  });
});

describe("MailboxId.unchecked", () => {
  it("wraps a value without validation", () => {
    expect(MailboxId.unchecked("anything").value).toBe("anything");
  });
});

describe("MailboxId.emailAddress", () => {
  it("builds the full inbound address from the mailbox and a domain", () => {
    expect(
      MailboxId.unchecked("river.castle.42").emailAddress("news.app"),
    ).toBe("river.castle.42@news.app");
  });
});
