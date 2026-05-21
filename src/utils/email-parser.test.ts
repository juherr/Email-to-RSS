import { describe, it, expect } from "vitest";
import { EmailParser } from "./email-parser";

describe("EmailParser.extractFeedId", () => {
  it("extracts a valid feed ID from an email address", () => {
    expect(EmailParser.extractFeedId("river.castle.42@example.com")).toBe(
      "river.castle.42",
    );
  });

  it("is case-insensitive for the local part", () => {
    expect(EmailParser.extractFeedId("River.Castle.42@example.com")).toBe(
      "River.Castle.42",
    );
  });

  it("returns null for an address with no feed ID format", () => {
    expect(EmailParser.extractFeedId("user@example.com")).toBeNull();
  });

  it("returns null for a plain string without @", () => {
    expect(EmailParser.extractFeedId("notanemail")).toBeNull();
  });

  it("returns null when the numeric suffix is only one digit", () => {
    expect(EmailParser.extractFeedId("river.castle.4@example.com")).toBeNull();
  });

  it("returns null when the numeric suffix has more than two digits", () => {
    expect(
      EmailParser.extractFeedId("river.castle.123@example.com"),
    ).toBeNull();
  });
});

describe("EmailParser.decodeEncodedWords", () => {
  it("returns plain text unchanged", () => {
    expect(EmailParser.decodeEncodedWords("Hello World")).toBe("Hello World");
  });

  it("returns empty string for empty input", () => {
    expect(EmailParser.decodeEncodedWords("")).toBe("");
  });

  it("decodes a Base64-encoded word (UTF-8 subject)", () => {
    // =?UTF-8?B?SGVsbG8=?= → "Hello"
    expect(EmailParser.decodeEncodedWords("=?UTF-8?B?SGVsbG8=?=")).toBe(
      "Hello",
    );
  });

  it("decodes a quoted-printable encoded word", () => {
    // =?UTF-8?Q?caf=C3=A9?= → "café" (but decodeQuotedPrintable works byte-by-byte)
    // Use a simple ASCII QP sequence to stay charset-agnostic in tests
    // =?US-ASCII?Q?Hello=20World?= → "Hello World" (=20 → space, _ → space)
    expect(EmailParser.decodeEncodedWords("=?US-ASCII?Q?Hello=20World?=")).toBe(
      "Hello World",
    );
  });

  it("decodes underscores as spaces in QP encoding", () => {
    expect(EmailParser.decodeEncodedWords("=?US-ASCII?Q?Hello_World?=")).toBe(
      "Hello World",
    );
  });

  it("leaves unrecognised encoded-word syntax unchanged", () => {
    expect(EmailParser.decodeEncodedWords("=?UTF-8?X?something?=")).toBe(
      "=?UTF-8?X?something?=",
    );
  });
});

describe("EmailParser.parseForwardEmailPayload", () => {
  it("throws on null payload", () => {
    expect(() => EmailParser.parseForwardEmailPayload(null)).toThrow(
      "Missing or invalid webhook payload",
    );
  });

  it("throws on undefined payload", () => {
    expect(() => EmailParser.parseForwardEmailPayload(undefined)).toThrow();
  });

  it("parses subject, from, and HTML content", () => {
    const payload = {
      subject: "Test Subject",
      from: { text: "sender@example.com" },
      html: "<p>Hello</p>",
      date: "2024-01-15T10:00:00.000Z",
    };
    const result = EmailParser.parseForwardEmailPayload(payload);
    expect(result.subject).toBe("Test Subject");
    expect(result.from).toBe("sender@example.com");
    expect(result.content).toBe("<p>Hello</p>");
    expect(result.receivedAt).toBe(
      new Date("2024-01-15T10:00:00.000Z").getTime(),
    );
  });

  it("prefers HTML content over plain text", () => {
    const payload = {
      from: { text: "a@b.com" },
      html: "<b>HTML</b>",
      text: "Plain",
    };
    expect(EmailParser.parseForwardEmailPayload(payload).content).toBe(
      "<b>HTML</b>",
    );
  });

  it("falls back to plain text when HTML is absent", () => {
    const payload = {
      from: { text: "a@b.com" },
      text: "Plain text",
    };
    expect(EmailParser.parseForwardEmailPayload(payload).content).toBe(
      "Plain text",
    );
  });

  it("uses structured from.value when from.text is absent", () => {
    const payload = {
      from: {
        value: [{ name: "Alice", address: "alice@example.com" }],
      },
      html: "",
    };
    const result = EmailParser.parseForwardEmailPayload(payload);
    expect(result.from).toBe("Alice <alice@example.com>");
  });

  it("falls back to Unknown Sender when from is absent", () => {
    const result = EmailParser.parseForwardEmailPayload({ html: "" });
    expect(result.from).toBe("Unknown Sender");
  });

  it("uses Date.now() when date field is absent", () => {
    const before = Date.now();
    const result = EmailParser.parseForwardEmailPayload({
      from: { text: "x@y.com" },
    });
    const after = Date.now();
    expect(result.receivedAt).toBeGreaterThanOrEqual(before);
    expect(result.receivedAt).toBeLessThanOrEqual(after);
  });

  it("defaults subject to 'No Subject' when absent", () => {
    const result = EmailParser.parseForwardEmailPayload({
      from: { text: "x@y.com" },
    });
    expect(result.subject).toBe("No Subject");
  });

  it("extracts headers from headerLines array", () => {
    const payload = {
      from: { text: "x@y.com" },
      headerLines: [
        { key: "X-Custom", line: "X-Custom: my-value" },
        { key: "List-ID", line: "List-ID: <list.example.com>" },
      ],
    };
    const result = EmailParser.parseForwardEmailPayload(payload);
    expect(result.headers["x-custom"]).toBe("my-value");
    expect(result.headers["list-id"]).toBe("<list.example.com>");
  });

  it("extracts headers from raw headers string", () => {
    const payload = {
      from: { text: "x@y.com" },
      headers: "X-Foo: bar\r\nX-Baz: qux",
    };
    const result = EmailParser.parseForwardEmailPayload(payload);
    expect(result.headers["x-foo"]).toBe("bar");
    expect(result.headers["x-baz"]).toBe("qux");
  });

  it("decodes RFC 2047 encoded-word subjects", () => {
    const payload = {
      from: { text: "x@y.com" },
      subject: "=?UTF-8?B?SGVsbG8=?=",
    };
    expect(EmailParser.parseForwardEmailPayload(payload).subject).toBe("Hello");
  });
});
