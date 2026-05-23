import { describe, it, expect } from "vitest";
import worker from "../index";
import { createMockEnv } from "../test/setup";
import { iconKey } from "../utils/storage";
import type { Env } from "../types";

function req(path: string): Request {
  return new Request(`https://test.getmynews.app${path}`);
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 9, 8, 7]);

function toBase64(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes));
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

describe("per-feed favicon", () => {
  it("serves the cached domain icon when available", async () => {
    const env = createMockEnv() as unknown as Env;
    await env.EMAIL_STORAGE.put(
      "feed:abc:metadata",
      JSON.stringify({ emails: [], iconDomain: "github.com" }),
    );
    await env.EMAIL_STORAGE.put(
      iconKey("github.com"),
      JSON.stringify({ data: toBase64(PNG), contentType: "image/png" }),
    );

    const res = await worker.fetch(req("/favicon/abc"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
  });

  it("falls back to the project SVG when the feed has no icon domain", async () => {
    const env = createMockEnv() as unknown as Env;
    await env.EMAIL_STORAGE.put(
      "feed:abc:metadata",
      JSON.stringify({ emails: [] }),
    );

    const res = await worker.fetch(req("/favicon/abc"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
    expect(await res.text()).toContain("<svg");
  });

  it("falls back to the project SVG for a negative cache entry", async () => {
    const env = createMockEnv() as unknown as Env;
    await env.EMAIL_STORAGE.put(
      "feed:abc:metadata",
      JSON.stringify({ emails: [], iconDomain: "nope.test" }),
    );
    await env.EMAIL_STORAGE.put(
      iconKey("nope.test"),
      JSON.stringify({ data: null, contentType: "" }),
    );

    const res = await worker.fetch(req("/favicon/abc"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
  });

  it("falls back to the project SVG for an unknown feed", async () => {
    const env = createMockEnv() as unknown as Env;
    const res = await worker.fetch(req("/favicon/missing"), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toMatch(/^image\/svg\+xml/);
  });
});
