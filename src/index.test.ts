import { describe, it, expect } from "vitest";
import worker from "./index";
import { createMockEnv } from "./test/setup";
import type { Env } from "./types";

const env = createMockEnv();

function req(path: string, init: RequestInit = {}): Request {
  return new Request(`https://test.getmynews.app${path}`, init);
}

describe("CORS middleware", () => {
  it("adds CORS headers for an allowed origin", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", { headers: { Origin: "https://getmynews.app" } }),
      env as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://getmynews.app",
    );
  });

  it("omits CORS headers for an unknown origin", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", { headers: { Origin: "https://evil.com" } }),
      env as unknown as Env,
    );
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("handles OPTIONS preflight for an allowed origin with 204", async () => {
    const res = await worker.fetch(
      req("/rss/some-feed", {
        method: "OPTIONS",
        headers: {
          Origin: "https://getmynews.app",
          "Access-Control-Request-Method": "GET",
        },
      }),
      env as unknown as Env,
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://getmynews.app",
    );
  });
});
