import { describe, it, expect, beforeEach } from "vitest";
import "../test/setup";
import { createMockEnv, MockR2 } from "../test/setup";
import { Hono } from "hono";
import { handle as handleFiles } from "./files";

async function request(
  env: ReturnType<typeof createMockEnv>,
  path: string,
): Promise<Response> {
  const app = new Hono();
  const files = new Hono();
  files.get("/:attachmentId/:filename", handleFiles);
  app.route("/files", files);
  return app.request(path, {}, env as any);
}

describe("GET /files/:attachmentId/:filename", () => {
  let envNoR2: ReturnType<typeof createMockEnv>;
  let envWithR2: ReturnType<typeof createMockEnv>;
  let mockR2: MockR2;

  beforeEach(() => {
    envNoR2 = createMockEnv();
    envWithR2 = createMockEnv({ withR2: true });
    mockR2 = (envWithR2 as any).ATTACHMENT_BUCKET as unknown as MockR2;
  });

  it("returns 404 when ATTACHMENT_BUCKET is not configured", async () => {
    const res = await request(envNoR2, "/files/some-id/file.pdf");
    expect(res.status).toBe(404);
    expect(await res.text()).toContain("not configured");
  });

  it("returns 404 when attachment ID is not found in R2", async () => {
    const res = await request(envWithR2, "/files/unknown-id/file.pdf");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("Not found");
  });

  it("returns 200 with stored content when attachment exists", async () => {
    const content = new TextEncoder().encode("PDF content")
      .buffer as ArrayBuffer;
    await mockR2.put("test-uuid", content, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const res = await request(envWithR2, "/files/test-uuid/report.pdf");
    expect(res.status).toBe(200);
  });

  it("returns correct Content-Type from stored httpMetadata", async () => {
    const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await mockR2.put("img-uuid", content, {
      httpMetadata: { contentType: "image/png" },
    });

    const res = await request(envWithR2, "/files/img-uuid/photo.png");
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("image/png");
  });

  it("sets Cache-Control immutable header", async () => {
    const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await mockR2.put("cache-uuid", content, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const res = await request(envWithR2, "/files/cache-uuid/doc.pdf");
    expect(res.headers.get("Cache-Control")).toBe(
      "public, max-age=31536000, immutable",
    );
  });

  it("sets X-Robots-Tag: noindex", async () => {
    const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await mockR2.put("robots-uuid", content, {
      httpMetadata: { contentType: "application/pdf" },
    });

    const res = await request(envWithR2, "/files/robots-uuid/doc.pdf");
    expect(res.headers.get("X-Robots-Tag")).toBe("noindex");
  });

  it("sets Content-Disposition from httpMetadata when present", async () => {
    const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await mockR2.put("disp-uuid", content, {
      httpMetadata: {
        contentType: "application/pdf",
        contentDisposition: 'attachment; filename="stored.pdf"',
      },
    });

    const res = await request(envWithR2, "/files/disp-uuid/other.pdf");
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="stored.pdf"',
    );
  });

  it("falls back to URL filename for Content-Disposition when not in httpMetadata", async () => {
    const content = new TextEncoder().encode("data").buffer as ArrayBuffer;
    await mockR2.put("fallback-uuid", content, {
      httpMetadata: { contentType: "text/plain" },
    });

    const res = await request(
      envWithR2,
      "/files/fallback-uuid/hello%20world.txt",
    );
    expect(res.headers.get("Content-Disposition")).toBe(
      'attachment; filename="hello world.txt"',
    );
  });
});
