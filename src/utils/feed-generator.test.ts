import { describe, it, expect } from "vitest";
import { generateRssFeed, generateAtomFeed } from "./feed-generator";
import { FeedConfig, EmailData } from "../types";

const mockFeedConfig: FeedConfig = {
  title: "Test Newsletter",
  description: "A test feed",
  site_url: "https://test.getmynews.app/rss/abc123",
  feed_url: "https://test.getmynews.app/rss/abc123",
  language: "en",
  created_at: 1700000000000,
};

const mockEmails: EmailData[] = [
  {
    subject: "Hello World",
    from: "Alice <alice@example.com>",
    content: "<p>Hello from Alice</p>",
    receivedAt: 1700000001000,
    headers: {},
  },
];

const mockEmailWithAttachment: EmailData = {
  ...mockEmails[0],
  attachments: [
    {
      id: "550e8400-e29b-41d4-a716-446655440000",
      filename: "report.pdf",
      contentType: "application/pdf",
      size: 12345,
    },
  ],
};

const BASE_URL = "https://test.getmynews.app";
const FEED_ID = "abc123";

describe("generateRssFeed", () => {
  it("returns RSS 2.0 with channel element", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<channel>");
    expect(result).toContain("<title>Test Newsletter</title>");
  });

  it("includes <enclosure> element for email with attachment", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      [mockEmailWithAttachment],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<enclosure");
    expect(result).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toContain("report.pdf");
    expect(result).toContain("application/pdf");
    expect(result).toContain("12345");
  });

  it("does not include <enclosure> for email without attachments", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).not.toContain("<enclosure");
  });

  it("enclosure URL uses /files/{id}/{filename} scheme", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      [mockEmailWithAttachment],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(
      `${BASE_URL}/files/550e8400-e29b-41d4-a716-446655440000/report.pdf`,
    );
  });

  it("includes rss self-link in RSS output", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(`${BASE_URL}/rss/${FEED_ID}`);
  });

  it("includes email entries as <item> elements", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<item>");
    expect(result).toContain("Hello World");
  });

  it("works with empty emails array", () => {
    const result = generateRssFeed(mockFeedConfig, [], BASE_URL, FEED_ID);
    expect(result).toContain("<channel>");
    expect(result).not.toContain("<item>");
  });
});

describe("generateAtomFeed", () => {
  it("returns Atom 1.0 namespace", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain('xmlns="http://www.w3.org/2005/Atom"');
  });

  it("contains <feed> root element", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<feed");
    expect(result).toContain("</feed>");
  });

  it("includes feed title", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("Test Newsletter");
  });

  it("includes <entry> elements for each email", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<entry>");
    expect(result).toContain("Hello World");
  });

  it("includes author information", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("Alice");
  });

  it("self-link points to atom URL", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(`${BASE_URL}/atom/${FEED_ID}`);
  });

  it("includes rss alternate link", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(`${BASE_URL}/rss/${FEED_ID}`);
  });

  it("works with empty emails array", () => {
    const result = generateAtomFeed(mockFeedConfig, [], BASE_URL, FEED_ID);
    expect(result).toContain("<feed");
    expect(result).not.toContain("<entry>");
  });

  it("handles config without description", () => {
    const configNoDesc: FeedConfig = {
      ...mockFeedConfig,
      description: undefined,
    };
    const result = generateAtomFeed(
      configNoDesc,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain('xmlns="http://www.w3.org/2005/Atom"');
  });

  it("handles config with author field", () => {
    const configWithAuthor: FeedConfig = { ...mockFeedConfig, author: "Bob" };
    const result = generateAtomFeed(
      configWithAuthor,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("Bob");
  });

  it("includes enclosure link for email with attachment in Atom feed", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      [mockEmailWithAttachment],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain('rel="enclosure"');
    expect(result).toContain("550e8400-e29b-41d4-a716-446655440000");
    expect(result).toContain("report.pdf");
  });

  it("does not include enclosure link for email without attachments in Atom feed", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).not.toContain('rel="enclosure"');
  });
});
