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

  async put(key: string, value: any) {
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
    options?: CacheQueryOptions,
  ): Promise<Response | undefined> {
    const key = request instanceof Request ? request.url : request;
    const response = this.store.get(key);
    return response?.clone();
  }

  async delete(
    request: RequestInfo,
    options?: CacheQueryOptions,
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
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const g = globalThis as any;

  // Mock Cloudflare Workers runtime globals
  g.caches = {
    default: new MockCache(),
    open: async () => new MockCache(),
  } as unknown as CacheStorage;

  // Mock crypto for generating random values
  if (!g.crypto) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    g.crypto = require("crypto").webcrypto;
  }

  // Ensure other required globals are available
  if (!g.FormData) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { FormData } = require("undici");
    g.FormData = FormData;
  }

  if (!g.Headers) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Headers } = require("undici");
    g.Headers = Headers;
  }

  if (!g.Request) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { Request } = require("undici");
    g.Request = Request;
  }

  if (!g.Response) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
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
 * Create a mock environment for testing
 * @returns Mock environment with KV storage and configuration
 */
export const createMockEnv = () => ({
  EMAIL_STORAGE: new MockKV(),
  DOMAIN: "test.getmynews.app",
  ADMIN_PASSWORD: "test-password",
});
