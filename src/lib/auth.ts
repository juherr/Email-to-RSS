import { Context } from "hono";
import { Env } from "../types";

/**
 * Constant-time string comparison. Prefers the runtime's native
 * `crypto.subtle.timingSafeEqual` (Cloudflare Workers) and falls back to a
 * manual constant-time loop in environments that lack it (Node test runtime).
 */
export function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aBytes = enc.encode(a);
  const bBytes = enc.encode(b);
  // Try native timing-safe implementation first (Cloudflare Workers runtime)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const subtle = crypto.subtle as any;
  if (typeof subtle.timingSafeEqual === "function") {
    if (aBytes.length !== bBytes.length) return false;
    return subtle.timingSafeEqual(aBytes, bBytes);
  }
  // Constant-time fallback for Node (test environment): encode length
  // mismatch into `diff` so the loop always runs over the full length.
  const len = Math.max(aBytes.length, bBytes.length);
  let diff = aBytes.length ^ bBytes.length;
  for (let i = 0; i < len; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}

/**
 * Reverse-proxy authentication: trusted only when both `PROXY_AUTH_SECRET` and
 * `PROXY_TRUSTED_IPS` are configured, the request comes from a trusted IP, the
 * shared secret matches, and a `Remote-User`/`X-Forwarded-User` is present.
 */
export function checkProxyAuth(c: Context, env: Env): boolean {
  if (!env.PROXY_AUTH_SECRET || !env.PROXY_TRUSTED_IPS) return false;

  const trustedIps = env.PROXY_TRUSTED_IPS.split(",")
    .map((s: string) => s.trim())
    .filter(Boolean);
  const clientIp = c.req.header("CF-Connecting-IP") ?? "";
  const providedSecret = c.req.header("X-Auth-Proxy-Secret") ?? "";
  const remoteUser =
    c.req.header("Remote-User") || c.req.header("X-Forwarded-User") || "";

  return (
    trustedIps.includes(clientIp) &&
    timingSafeEqual(providedSecret, env.PROXY_AUTH_SECRET) &&
    remoteUser.length > 0
  );
}

/**
 * Authentication for the machine-facing REST API (`/api/v1/*`).
 * Grants access when proxy auth passes OR the request carries a valid
 * `Authorization: Bearer <ADMIN_PASSWORD>`. No cookie, no CSRF — token only.
 */
export async function apiAuthMiddleware(
  c: Context<{ Bindings: Env }>,
  next: () => Promise<void>,
): Promise<Response | void> {
  const env = c.env;

  if (checkProxyAuth(c, env)) {
    return next();
  }

  const authHeader = c.req.header("Authorization") ?? "";
  const token = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length)
    : "";

  if (token && timingSafeEqual(token, env.ADMIN_PASSWORD)) {
    return next();
  }

  return c.json({ error: "Unauthorized" }, 401);
}
