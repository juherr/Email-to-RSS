import { describe, it, expect } from "vitest";
import {
  feedRssUrl,
  feedAtomUrl,
  feedJsonUrl,
  feedFormatUrl,
  feedValidatorUrl,
} from "./urls";
import { Env } from "../types";

const env = { DOMAIN: "getmynews.app" } as Env;
const feedId = "gAf6wiKyanpppcKX9o3B_Q";

describe("feed URL builders", () => {
  it("builds RSS/Atom/JSON feed URLs", () => {
    expect(feedRssUrl(feedId, env)).toBe(
      "https://getmynews.app/rss/gAf6wiKyanpppcKX9o3B_Q",
    );
    expect(feedAtomUrl(feedId, env)).toBe(
      "https://getmynews.app/atom/gAf6wiKyanpppcKX9o3B_Q",
    );
    expect(feedJsonUrl(feedId, env)).toBe(
      "https://getmynews.app/json/gAf6wiKyanpppcKX9o3B_Q",
    );
  });

  it("resolves a format to its feed URL", () => {
    expect(feedFormatUrl("rss", feedId, env)).toBe(feedRssUrl(feedId, env));
    expect(feedFormatUrl("atom", feedId, env)).toBe(feedAtomUrl(feedId, env));
    expect(feedFormatUrl("json", feedId, env)).toBe(feedJsonUrl(feedId, env));
  });
});

describe("feedValidatorUrl", () => {
  it("points JSON feeds at validator.jsonfeed.org with the encoded feed URL", () => {
    expect(feedValidatorUrl("json", feedId, env)).toBe(
      "https://validator.jsonfeed.org/?url=" +
        encodeURIComponent(feedJsonUrl(feedId, env)),
    );
  });

  it("points RSS and Atom feeds at the W3C feed validator", () => {
    expect(feedValidatorUrl("rss", feedId, env)).toBe(
      "https://validator.w3.org/feed/check.cgi?url=" +
        encodeURIComponent(feedRssUrl(feedId, env)),
    );
    expect(feedValidatorUrl("atom", feedId, env)).toBe(
      "https://validator.w3.org/feed/check.cgi?url=" +
        encodeURIComponent(feedAtomUrl(feedId, env)),
    );
  });

  it("percent-encodes the feed URL so the validator query is well-formed", () => {
    const url = feedValidatorUrl("json", feedId, env);
    expect(url).toContain("https%3A%2F%2Fgetmynews.app%2Fjson%2F");
    expect(url).not.toContain("?url=https://");
  });
});
