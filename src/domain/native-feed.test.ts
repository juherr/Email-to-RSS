import { describe, it, expect } from "vitest";
import { detectNativeFeeds, unionNativeFeeds } from "./native-feed";

describe("detectNativeFeeds", () => {
  it("maps the three canonical MIME types to kinds", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/atom", type: "application/atom+xml" },
        { href: "https://x.com/rss", type: "application/rss+xml" },
        { href: "https://x.com/json", type: "application/feed+json" },
      ]),
    ).toEqual([
      { url: "https://x.com/atom", type: "atom" },
      { url: "https://x.com/rss", type: "rss" },
      { url: "https://x.com/json", type: "json" },
    ]);
  });

  it("ignores unknown MIME types (application/json, text/html)", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/api", type: "application/json" },
        { href: "https://x.com/", type: "text/html" },
      ]),
    ).toEqual([]);
  });

  it("strips MIME parameters and is case-insensitive", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/f", type: "Application/RSS+XML; charset=utf-8" },
      ]),
    ).toEqual([{ url: "https://x.com/f", type: "rss" }]);
  });

  it("dedupes by URL (first kind wins)", () => {
    expect(
      detectNativeFeeds([
        { href: "https://x.com/f", type: "application/rss+xml" },
        { href: "https://x.com/f", type: "application/atom+xml" },
      ]),
    ).toEqual([{ url: "https://x.com/f", type: "rss" }]);
  });
});

describe("unionNativeFeeds", () => {
  it("returns [] for undefined", () => {
    expect(unionNativeFeeds(undefined)).toEqual([]);
  });

  it("unions across senders, deduping by URL", () => {
    expect(
      unionNativeFeeds({
        "a@x.com": [{ url: "https://x.com/rss", type: "rss" }],
        "b@y.com": [
          { url: "https://x.com/rss", type: "rss" },
          { url: "https://y.com/atom", type: "atom" },
        ],
      }),
    ).toEqual([
      { url: "https://x.com/rss", type: "rss" },
      { url: "https://y.com/atom", type: "atom" },
    ]);
  });
});
