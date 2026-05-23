import { describe, it, expect } from "vitest";
import worker from "../index";
import { createMockEnv } from "../test/setup";
import type { Env } from "../types";

function req(path: string): Request {
  return new Request(`https://test.getmynews.app${path}`);
}

describe("project favicon", () => {
  it("serves an SVG favicon at /favicon.svg", async () => {
    const env = createMockEnv() as unknown as Env;
    const res = await worker.fetch(req("/favicon.svg"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
    expect(res.headers.get("Cache-Control")).toContain("max-age");
    const body = await res.text();
    expect(body).toContain("<svg");
  });

  it("serves the same icon at /favicon.ico", async () => {
    const env = createMockEnv() as unknown as Env;
    const res = await worker.fetch(req("/favicon.ico"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
    const body = await res.text();
    expect(body).toContain("<svg");
  });
});
