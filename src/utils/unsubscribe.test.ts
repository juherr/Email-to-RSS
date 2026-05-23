import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server, createMockEnv } from "../test/setup";
import {
  parseOneClickUnsubscribe,
  sendOneClickUnsubscribe,
  sendUnsubscribes,
} from "./unsubscribe";
import { getCounters } from "./stats";
import type { Env } from "../types";

const POST_HEADER = "List-Unsubscribe=One-Click";

describe("parseOneClickUnsubscribe", () => {
  it("returns the https URL when the one-click Post header is present", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe": "<https://news.example.com/u?t=abc>",
        "list-unsubscribe-post": POST_HEADER,
      }),
    ).toBe("https://news.example.com/u?t=abc");
  });

  it("prefers the https URL when both https and mailto are present", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe":
          "<mailto:unsub@example.com>, <https://example.com/u/1>",
        "list-unsubscribe-post": POST_HEADER,
      }),
    ).toBe("https://example.com/u/1");
  });

  it("returns null for a mailto-only header", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe": "<mailto:unsub@example.com>",
        "list-unsubscribe-post": POST_HEADER,
      }),
    ).toBeNull();
  });

  it("returns null when the Post header is missing", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe": "<https://example.com/u/1>",
      }),
    ).toBeNull();
  });

  it("returns null when the Post header has the wrong value", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe": "<https://example.com/u/1>",
        "list-unsubscribe-post": "List-Unsubscribe=Something",
      }),
    ).toBeNull();
  });

  it("matches headers and Post value case-insensitively", () => {
    expect(
      parseOneClickUnsubscribe({
        "List-Unsubscribe": "<https://example.com/u/1>",
        "List-Unsubscribe-Post": "list-unsubscribe=ONE-CLICK",
      }),
    ).toBe("https://example.com/u/1");
  });

  it("ignores plaintext http URLs", () => {
    expect(
      parseOneClickUnsubscribe({
        "list-unsubscribe": "<http://example.com/u/1>",
        "list-unsubscribe-post": POST_HEADER,
      }),
    ).toBeNull();
  });

  it("returns null when there are no headers", () => {
    expect(parseOneClickUnsubscribe({})).toBeNull();
  });
});

describe("sendOneClickUnsubscribe", () => {
  it("POSTs the one-click body and returns true on success", async () => {
    let captured: { method: string; contentType: string; body: string } | null =
      null;
    server.use(
      http.post("https://example.com/u/1", async ({ request }) => {
        captured = {
          method: request.method,
          contentType: request.headers.get("content-type") ?? "",
          body: await request.text(),
        };
        return HttpResponse.text("ok");
      }),
    );

    const ok = await sendOneClickUnsubscribe("https://example.com/u/1");

    expect(ok).toBe(true);
    expect(captured).toEqual({
      method: "POST",
      contentType: "application/x-www-form-urlencoded",
      body: POST_HEADER,
    });
  });

  it("returns false on a non-ok response", async () => {
    server.use(
      http.post("https://example.com/u/1", () =>
        HttpResponse.text("nope", { status: 404 }),
      ),
    );
    expect(await sendOneClickUnsubscribe("https://example.com/u/1")).toBe(
      false,
    );
  });

  it("returns false (no throw) on a network error", async () => {
    server.use(
      http.post("https://example.com/u/1", () => HttpResponse.error()),
    );
    expect(await sendOneClickUnsubscribe("https://example.com/u/1")).toBe(
      false,
    );
  });
});

describe("sendUnsubscribes", () => {
  it("de-dupes URLs and bumps unsubscribes_sent by the success count", async () => {
    const env = createMockEnv() as unknown as Env;
    let hitsOne = 0;
    let hitsTwo = 0;
    server.use(
      http.post("https://example.com/a", () => {
        hitsOne += 1;
        return HttpResponse.text("ok");
      }),
      http.post("https://example.com/b", () => {
        hitsTwo += 1;
        return HttpResponse.text("ok");
      }),
    );

    await sendUnsubscribes(
      [
        "https://example.com/a",
        "https://example.com/a",
        "https://example.com/b",
      ],
      env,
    );

    expect(hitsOne).toBe(1);
    expect(hitsTwo).toBe(1);
    const counters = await getCounters(env.EMAIL_STORAGE);
    expect(counters.unsubscribes_sent).toBe(2);
  });

  it("only counts successful requests", async () => {
    const env = createMockEnv() as unknown as Env;
    server.use(
      http.post("https://example.com/ok", () => HttpResponse.text("ok")),
      http.post("https://example.com/bad", () =>
        HttpResponse.text("no", { status: 500 }),
      ),
    );

    await sendUnsubscribes(
      ["https://example.com/ok", "https://example.com/bad"],
      env,
    );

    const counters = await getCounters(env.EMAIL_STORAGE);
    expect(counters.unsubscribes_sent).toBe(1);
  });

  it("does nothing for an empty list", async () => {
    const env = createMockEnv() as unknown as Env;
    await sendUnsubscribes([], env);
    const counters = await getCounters(env.EMAIL_STORAGE);
    expect(counters.unsubscribes_sent).toBe(0);
  });
});
