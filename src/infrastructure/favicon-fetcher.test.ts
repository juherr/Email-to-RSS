import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server, createMockEnv } from "../test/setup";
import {
  cacheFaviconForDomain,
  extractEmailDomain,
  getCachedIcon,
} from "./favicon-fetcher";
import { IconRepository } from "./icon-repository";
import {
  ICON_NEGATIVE_TTL_SECONDS,
  ICON_TTL_SECONDS,
  MAX_ICON_BYTES,
} from "../config/constants";

const iconKey = (domain: string) => `icon:${domain}`;
import type { Env } from "../types";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]);

function imageResponse(bytes: Uint8Array, contentType = "image/png") {
  return new HttpResponse(bytes, { headers: { "Content-Type": contentType } });
}

describe("extractEmailDomain", () => {
  it("parses a bare address", () => {
    expect(extractEmailDomain("news@github.com")).toBe("github.com");
  });

  it("parses a display-form address", () => {
    expect(extractEmailDomain("GitHub <news@GitHub.com>")).toBe("github.com");
  });

  it("strips a trailing dot and lowercases", () => {
    expect(extractEmailDomain("a@Example.COM.")).toBe("example.com");
  });

  it("returns null when there is no address", () => {
    expect(extractEmailDomain("not an email")).toBeNull();
  });
});

describe("cacheFaviconForDomain", () => {
  it("caches the direct /favicon.ico when available", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://github.com/favicon.ico", () => imageResponse(PNG)),
    );

    await cacheFaviconForDomain("github.com", env);

    const record = await env.EMAIL_STORAGE.get(iconKey("github.com"), "json");
    expect(record).toMatchObject({ contentType: "image/png" });
    expect((record as { data: string }).data).toBeTruthy();
    expect(record).not.toHaveProperty("fetchedAt");

    const icon = await getCachedIcon("github.com", env);
    expect(icon?.contentType).toBe("image/png");
    expect(new Uint8Array(icon!.bytes)).toEqual(PNG);
  });

  it("falls back to DuckDuckGo when the direct icon 404s", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://acme.test/favicon.ico", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
      http.get("https://icons.duckduckgo.com/ip3/acme.test.ico", () =>
        imageResponse(PNG, "image/x-icon"),
      ),
    );

    await cacheFaviconForDomain("acme.test", env);

    const icon = await getCachedIcon("acme.test", env);
    expect(icon?.contentType).toBe("image/x-icon");
  });

  it("falls back to the apex domain when the subdomain has no icon", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://mail.acme.test/favicon.ico", () =>
        HttpResponse.error(),
      ),
      http.get("https://icons.duckduckgo.com/ip3/mail.acme.test.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
      http.get("https://acme.test/favicon.ico", () =>
        imageResponse(PNG, "image/vnd.microsoft.icon"),
      ),
    );

    await cacheFaviconForDomain("mail.acme.test", env);

    // Cached under the original sender domain, so reads still hit.
    const icon = await getCachedIcon("mail.acme.test", env);
    expect(icon?.contentType).toBe("image/vnd.microsoft.icon");
    expect(new Uint8Array(icon!.bytes)).toEqual(PNG);
  });

  it("writes a negative entry when no icon is found", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://nope.test/favicon.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
      http.get("https://icons.duckduckgo.com/ip3/nope.test.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
    );

    await cacheFaviconForDomain("nope.test", env);

    const record = await env.EMAIL_STORAGE.get(iconKey("nope.test"), "json");
    expect(record).toEqual({ data: null, contentType: "" });
    expect(await getCachedIcon("nope.test", env)).toBeNull();
  });

  it("gives a negative entry a short TTL so transient misses self-heal", async () => {
    const env = createMockEnv() as unknown as Env;
    const put = vi.spyOn(IconRepository.prototype, "put");
    server.use(
      http.get("https://transient.test/favicon.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
      http.get("https://icons.duckduckgo.com/ip3/transient.test.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
    );

    await cacheFaviconForDomain("transient.test", env);

    expect(put).toHaveBeenCalledWith(
      "transient.test",
      expect.any(String),
      ICON_NEGATIVE_TTL_SECONDS,
    );
    put.mockRestore();
  });

  it("gives a positive entry the full TTL", async () => {
    const env = createMockEnv() as unknown as Env;
    const put = vi.spyOn(IconRepository.prototype, "put");
    server.use(
      http.get("https://hit.test/favicon.ico", () => imageResponse(PNG)),
    );

    await cacheFaviconForDomain("hit.test", env);

    expect(put).toHaveBeenCalledWith(
      "hit.test",
      expect.any(String),
      ICON_TTL_SECONDS,
    );
    put.mockRestore();
  });

  it("rejects oversized responses as negative", async () => {
    const env = createMockEnv() as unknown as Env;
    const big = new Uint8Array(MAX_ICON_BYTES + 1);
    server.use(
      http.get("https://big.test/favicon.ico", () => imageResponse(big)),
      http.get("https://icons.duckduckgo.com/ip3/big.test.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
    );

    await cacheFaviconForDomain("big.test", env);
    expect(await getCachedIcon("big.test", env)).toBeNull();
  });

  it("rejects non-image content types as negative", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://html.test/favicon.ico", () =>
        HttpResponse.text("<html>", {
          headers: { "Content-Type": "text/html" },
        }),
      ),
      http.get("https://icons.duckduckgo.com/ip3/html.test.ico", () =>
        HttpResponse.text("", { status: 404 }),
      ),
    );

    await cacheFaviconForDomain("html.test", env);
    expect(await getCachedIcon("html.test", env)).toBeNull();
  });

  it("short-circuits when an entry already exists (no outbound fetch)", async () => {
    const env = createMockEnv() as unknown as Env;
    // Pre-seed a record; with MSW onUnhandledRequest:"error", any fetch fails.
    await env.EMAIL_STORAGE.put(
      iconKey("cached.test"),
      JSON.stringify({ data: null, contentType: "" }),
    );

    await expect(
      cacheFaviconForDomain("cached.test", env),
    ).resolves.toBeUndefined();
  });

  it("never throws on network errors", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.get("https://err.test/favicon.ico", () => HttpResponse.error()),
      http.get("https://icons.duckduckgo.com/ip3/err.test.ico", () =>
        HttpResponse.error(),
      ),
    );

    await expect(
      cacheFaviconForDomain("err.test", env),
    ).resolves.toBeUndefined();
  });
});
