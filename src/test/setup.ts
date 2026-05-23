import { beforeAll, afterAll, afterEach } from "vitest";
import { setupServer } from "msw/node";

// Minimal Node.js built-ins used only in this test setup file.
// Declared locally to avoid pulling in the full @types/node package,
// which would conflict with @cloudflare/workers-types globals.
declare function require(id: string): any;

/**
 * Mock KV namespace implementation
 * Simulates Cloudflare Workers KV storage using an in-memory Map
 */
class MockKV {
  private store: Map<string, any> = new Map();

  async get(
    key: string,
    typeOrOptions:
      | "text"
      | "json"
      | "arrayBuffer"
      | "stream"
      | { type: "text" | "json" | "arrayBuffer" | "stream" } = "text",
  ) {
    const type =
      typeof typeOrOptions === "string" ? typeOrOptions : typeOrOptions.type;
    const value = this.store.get(key);
    if (!value) return null;
    return type === "json" ? JSON.parse(value) : value;
  }

  async put(
    key: string,
    value: any,
    _options?: { expirationTtl?: number; expiration?: number },
  ) {
    // TTL options are accepted for API parity but not simulated in tests.
    this.store.set(
      key,
      typeof value === "string" ? value : JSON.stringify(value),
    );
    return undefined; // Match CF Workers KV behavior
  }

  async delete(key: string) {
    this.store.delete(key);
    return undefined; // Match CF Workers KV behavior
  }

  async list(options?: { prefix?: string; cursor?: string; limit?: number }) {
    const keys = Array.from(this.store.keys())
      .filter((key) => !options?.prefix || key.startsWith(options.prefix))
      .slice(0, options?.limit || undefined)
      .map((name) => ({ name }));

    return {
      keys,
      list_complete: true,
      cursor: "",
    };
  }
}

/**
 * Mock Cache implementation
 * Simulates Cloudflare Workers Cache API using an in-memory Map
 */
class MockCache implements Cache {
  private store: Map<string, Response> = new Map();

  async put(request: RequestInfo, response: Response): Promise<undefined> {
    const key = request instanceof Request ? request.url : request;
    this.store.set(key, response.clone());
    return undefined;
  }

  async match(
    request: RequestInfo,
    _options?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    const key = request instanceof Request ? request.url : request;
    const response = this.store.get(key);
    return response?.clone();
  }

  async delete(
    request: RequestInfo,
    _options?: CacheQueryOptions,
  ): Promise<boolean> {
    const key = request instanceof Request ? request.url : request;
    return this.store.delete(key);
  }

  // Required Cache interface methods with minimal implementations
  async add(): Promise<void> {
    throw new Error("Not implemented");
  }
  async addAll(): Promise<void> {
    throw new Error("Not implemented");
  }
  async keys(): Promise<Request[]> {
    return [];
  }
}

// Create MSW server for mocking external requests
export const server = setupServer();

// Setup before tests
beforeAll(() => {
  // Setup MSW server
  server.listen({ onUnhandledRequest: "error" });

  // Type-safe access to Node's global object for setting Workers-like globals in tests
  const g = globalThis as any;

  // Mock Cloudflare Workers runtime globals
  g.caches = {
    default: new MockCache(),
    open: async () => new MockCache(),
  } as unknown as CacheStorage;

  // Mock crypto for generating random values
  if (!g.crypto) {
    g.crypto = require("crypto").webcrypto;
  }

  // Ensure other required globals are available
  if (!g.FormData) {
    const { FormData } = require("undici");
    g.FormData = FormData;
  }

  if (!g.Headers) {
    const { Headers } = require("undici");
    g.Headers = Headers;
  }

  if (!g.Request) {
    const { Request } = require("undici");
    g.Request = Request;
  }

  if (!g.Response) {
    const { Response } = require("undici");
    g.Response = Response;
  }
});

// Clean up after tests
afterAll(() => {
  server.close();
});

afterEach(() => {
  server.resetHandlers();
});

/**
 * Mock R2 bucket implementation
 * Simulates Cloudflare Workers R2 storage using an in-memory Map
 */
export class MockR2 {
  private store: Map<
    string,
    {
      body: ArrayBuffer;
      httpMetadata?: { contentType?: string; contentDisposition?: string };
      httpEtag: string;
    }
  > = new Map();

  async put(
    key: string,
    value:
      | ReadableStream
      | ArrayBuffer
      | ArrayBufferView
      | string
      | null
      | Blob,
    options?: {
      httpMetadata?: { contentType?: string; contentDisposition?: string };
    },
  ) {
    let buffer: ArrayBuffer;
    if (value instanceof ArrayBuffer) {
      buffer = value;
    } else if (typeof value === "string") {
      buffer = new TextEncoder().encode(value).buffer as ArrayBuffer;
    } else if (ArrayBuffer.isView(value)) {
      buffer = value.buffer as ArrayBuffer;
    } else {
      buffer = new ArrayBuffer(0);
    }
    this.store.set(key, {
      body: buffer,
      httpMetadata: options?.httpMetadata,
      httpEtag: `"mock-etag-${key}"`,
    });
  }

  async get(key: string) {
    const entry = this.store.get(key);
    if (!entry) return null;
    return {
      key,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(entry.body));
          controller.close();
        },
      }),
      httpEtag: entry.httpEtag,
      httpMetadata: entry.httpMetadata,
      size: entry.body.byteLength,
      arrayBuffer: async () => entry.body,
      text: async () => new TextDecoder().decode(entry.body),
      writeHttpMetadata: (headers: Headers) => {
        if (entry.httpMetadata?.contentType) {
          headers.set("Content-Type", entry.httpMetadata.contentType);
        }
        if (entry.httpMetadata?.contentDisposition) {
          headers.set(
            "Content-Disposition",
            entry.httpMetadata.contentDisposition,
          );
        }
      },
    };
  }

  async delete(keys: string | string[]) {
    const arr = Array.isArray(keys) ? keys : [keys];
    for (const k of arr) {
      this.store.delete(k);
    }
  }

  _has(key: string) {
    return this.store.has(key);
  }
}

/**
 * Create a mock environment for testing
 * @returns Mock environment with KV storage and configuration
 */
export const createMockEnv = (options: { withR2?: boolean } = {}) => ({
  EMAIL_STORAGE: new MockKV(),
  DOMAIN: "test.getmynews.app",
  ADMIN_PASSWORD: "test-password",
  ...(options.withR2
    ? { ATTACHMENT_BUCKET: new MockR2() as unknown as R2Bucket }
    : {}),
});
