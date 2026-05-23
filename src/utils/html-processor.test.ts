import { describe, it, expect } from "vitest";
import { processEmailContent } from "./html-processor";
import type { AttachmentData } from "../types";

describe("processEmailContent — body extraction", () => {
  it("extracts content inside <body> tags", () => {
    const html = "<html><head></head><body><p>Hello</p></body></html>";
    expect(processEmailContent(html)).toBe("<p>Hello</p>");
  });

  it("handles body tag with attributes", () => {
    const html = '<html><body style="margin:0"><p>Hi</p></body></html>';
    expect(processEmailContent(html)).toBe("<p>Hi</p>");
  });

  it("returns fragment unchanged when no body tags present", () => {
    const fragment = "<p>Already a fragment</p>";
    expect(processEmailContent(fragment)).toBe("<p>Already a fragment</p>");
  });

  it("is case-insensitive for body tag matching", () => {
    const html = "<HTML><BODY><p>content</p></BODY></HTML>";
    expect(processEmailContent(html)).toBe("<p>content</p>");
  });
});

describe("processEmailContent — plain text", () => {
  it("wraps plain text in <pre>", () => {
    const text = "Hello world\nSecond line";
    const result = processEmailContent(text);
    expect(result).toMatch(/^<pre /);
    expect(result).toContain("Hello world\nSecond line");
  });

  it("escapes < and > in plain text", () => {
    const text = "Price < 10 & size > 5";
    const result = processEmailContent(text);
    expect(result).toContain("&lt;");
    expect(result).toContain("&gt;");
    expect(result).toContain("&amp;");
    expect(result).not.toContain("<10");
  });

  it("returns empty string for empty input", () => {
    expect(processEmailContent("")).toBe("");
  });
});

describe("processEmailContent — dangerous element removal", () => {
  it("removes <script> tags", () => {
    const html = "<body><p>Hello</p><script>alert('xss')</script></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<script");
    expect(result).not.toContain("alert");
    expect(result).toContain("<p>Hello</p>");
  });

  it("removes <iframe> tags", () => {
    const html =
      "<body><iframe src='https://evil.com'></iframe><p>ok</p></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<iframe");
    expect(result).toContain("<p>ok</p>");
  });

  it("removes <object> and <embed> tags", () => {
    const html = "<body><object></object><embed src='x'/><p>ok</p></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("<object");
    expect(result).not.toContain("<embed");
  });
});

describe("processEmailContent — attribute sanitization", () => {
  it("removes event handler attributes", () => {
    const html =
      "<body><a href='https://x.com' onclick='evil()'>link</a></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("onclick");
    expect(result).toContain('href="https://x.com"');
  });

  it("removes onerror on images", () => {
    const html = "<body><img src='x' onerror='evil()' /></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("onerror");
  });

  it("removes javascript: hrefs", () => {
    const html = "<body><a href='javascript:evil()'>click</a></body>";
    const result = processEmailContent(html);
    expect(result).not.toContain("javascript:");
  });

  it("preserves legitimate href and src attributes", () => {
    const html =
      "<body><a href='https://example.com'>link</a><img src='https://example.com/img.png'/></body>";
    const result = processEmailContent(html);
    expect(result).toContain("https://example.com");
  });
});

describe("processEmailContent — mso style cleanup", () => {
  it("strips mso-* properties from inline styles", () => {
    const html =
      '<body><p style="mso-margin-top: 0; color: red;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).not.toContain("mso-margin-top");
    expect(result).toContain("color: red");
  });

  it("removes style attribute entirely when only mso properties remain", () => {
    const html =
      '<body><p style="mso-line-height-rule: exactly;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).not.toContain("style=");
  });

  it("preserves style attribute when non-mso properties remain", () => {
    const html =
      '<body><p style="mso-font-size: 12pt; font-weight: bold;">text</p></body>';
    const result = processEmailContent(html);
    expect(result).toContain("font-weight");
    expect(result).not.toContain("mso-font-size");
  });
});

describe("processEmailContent — inline cid: rewriting", () => {
  const attachment = (
    overrides: Partial<AttachmentData> = {},
  ): AttachmentData => ({
    id: "att-123",
    filename: "chicken big.png",
    contentType: "image/png",
    size: 100,
    contentId: "ii_mpi85rqy0",
    ...overrides,
  });

  it("rewrites cid: src to a relative /files URL when no baseUrl", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0" alt="x"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
    expect(result).not.toContain("cid:");
  });

  it("rewrites cid: src to an absolute URL when baseUrl is given", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(
      html,
      [attachment()],
      "https://feed.example",
    );
    expect(result).toContain(
      'src="https://feed.example/files/att-123/chicken%20big.png"',
    );
  });

  it("matches a stored Content-ID that has angle brackets", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [
      attachment({ contentId: "<ii_mpi85rqy0>" }),
    ]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
  });

  it("is case-insensitive on the cid: scheme", () => {
    const html = '<body><img src="CID:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="/files/att-123/chicken%20big.png"');
  });

  it("leaves unknown cid references unchanged", () => {
    const html = '<body><img src="cid:unknown"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="cid:unknown"');
  });

  it("leaves cid references unchanged when no attachments are provided", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html);
    expect(result).toContain('src="cid:ii_mpi85rqy0"');
  });

  it("ignores attachments without a contentId", () => {
    const html = '<body><img src="cid:ii_mpi85rqy0"/></body>';
    const result = processEmailContent(html, [
      attachment({ contentId: undefined }),
    ]);
    expect(result).toContain('src="cid:ii_mpi85rqy0"');
  });

  it("does not touch normal http image sources", () => {
    const html = '<body><img src="https://example.com/a.png"/></body>';
    const result = processEmailContent(html, [attachment()]);
    expect(result).toContain('src="https://example.com/a.png"');
  });
});
