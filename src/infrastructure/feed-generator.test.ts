import { describe, it, expect } from "vitest";
import {
  generateRssFeed,
  generateAtomFeed,
  extractBodyContent,
} from "./feed-generator";
import { FeedConfig, EmailData } from "../types";

const mockFeedConfig: FeedConfig = {
  title: "Test Newsletter",
  description: "A test feed",
  language: "en",
  mailbox_id: "test.news.42",
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

describe("extractBodyContent", () => {
  it("extracts content inside <body> tags", () => {
    const html = "<html><head></head><body><p>Hello</p></body></html>";
    expect(extractBodyContent(html)).toBe("<p>Hello</p>");
  });

  it("handles body tag with attributes", () => {
    const html = '<html><body style="margin:0"><p>Hi</p></body></html>';
    expect(extractBodyContent(html)).toBe("<p>Hi</p>");
  });

  it("returns html unchanged when no body tags present", () => {
    const fragment = "<p>Already a fragment</p>";
    expect(extractBodyContent(fragment)).toBe(fragment);
  });

  it("is case-insensitive for body tag matching", () => {
    const html = "<HTML><BODY><p>content</p></BODY></HTML>";
    expect(extractBodyContent(html)).toBe("<p>content</p>");
  });
});

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

  it("includes the per-feed icon as the channel <image>", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<image>");
    expect(result).toContain(`${BASE_URL}/favicon/${FEED_ID}`);
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

  it("feed link points to the public read URL, never an admin path", () => {
    const result = generateRssFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(`<link>${BASE_URL}/rss/${FEED_ID}</link>`);
    expect(result).not.toContain("/admin/");
  });

  it("strips html/head/body wrapper from item description", () => {
    const emailWithFullHtml: EmailData = {
      ...mockEmails[0],
      content: "<html><head></head><body><p>Body only</p></body></html>",
    };
    const result = generateRssFeed(
      mockFeedConfig,
      [emailWithFullHtml],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<p>Body only</p>");
    expect(result).not.toContain("<html>");
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

  it("includes the per-feed icon as <icon> and <logo>", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    const iconUrl = `${BASE_URL}/favicon/${FEED_ID}`;
    expect(result).toContain(`<icon>${iconUrl}</icon>`);
    expect(result).toContain(`<logo>${iconUrl}</logo>`);
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

  it("feed link points to the public read URL, never an admin path", () => {
    const result = generateAtomFeed(
      mockFeedConfig,
      mockEmails,
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain(`${BASE_URL}/rss/${FEED_ID}`);
    expect(result).not.toContain("/admin/");
  });

  it("strips html/head/body wrapper from entry content", () => {
    const emailWithFullHtml: EmailData = {
      ...mockEmails[0],
      content: "<html><head></head><body><p>Body only</p></body></html>",
    };
    const result = generateAtomFeed(
      mockFeedConfig,
      [emailWithFullHtml],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("<p>Body only</p>");
    expect(result).not.toContain("<html>");
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

  it("renders the subject as plain text in <title> (strips tags, decodes entities)", () => {
    const emailWithHtmlSubject: EmailData = {
      ...mockEmails[0],
      subject: "<b>Sale</b> Tom &amp; Jerry",
    };
    const result = generateAtomFeed(
      mockFeedConfig,
      [emailWithHtmlSubject],
      BASE_URL,
      FEED_ID,
    );
    // Tags are stripped and entities decoded; markup must not survive.
    expect(result).toContain("Sale Tom & Jerry");
    expect(result).not.toContain("<b>Sale</b>");
  });

  it("strips XML-illegal control characters from the output", () => {
    const emailWithControlChar: EmailData = {
      ...mockEmails[0],
      subject: "Bad\x00\x1Fchar",
      content: "<p>body\x0Bhere</p>",
    };
    const result = generateAtomFeed(
      mockFeedConfig,
      [emailWithControlChar],
      BASE_URL,
      FEED_ID,
    );
    expect(result).not.toMatch(/[\x00\x0B\x1F]/);
  });

  it("preserves emoji (surrogate pairs) in the output", () => {
    const emailWithEmoji: EmailData = {
      ...mockEmails[0],
      subject: "Launch 🚀 today",
    };
    const result = generateAtomFeed(
      mockFeedConfig,
      [emailWithEmoji],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("🚀");
  });

  it("absolutizes relative content URLs against the sender domain", () => {
    const emailWithRelative: EmailData = {
      ...mockEmails[0],
      from: "News <news@acme.com>",
      content: '<body><a href="/article">read</a></body>',
    };
    const result = generateAtomFeed(
      mockFeedConfig,
      [emailWithRelative],
      BASE_URL,
      FEED_ID,
    );
    expect(result).toContain("https://acme.com/article");
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
