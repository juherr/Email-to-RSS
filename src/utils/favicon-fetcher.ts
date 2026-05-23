import { Env } from "../types";
import {
  ICON_FETCH_TIMEOUT_MS,
  ICON_TTL_SECONDS,
  MAX_ICON_BYTES,
} from "../config/constants";
import { iconKey } from "./storage";
import { logger } from "../lib/logger";

interface IconRecord {
  data: string | null; // base64 icon bytes, or null for a negative cache entry
  contentType: string;
}

/**
 * Extract the lowercased domain from a `from` value, accepting either a bare
 * address (`a@b.com`) or a display form (`Name <a@b.com>`). Returns null when
 * no plausible address can be parsed.
 */
export function extractEmailDomain(from: string): string | null {
  const match = from.match(/[^\s<>@]+@([^\s<>@]+\.[^\s<>@]+)/);
  if (!match) return null;
  const domain = match[1].trim().toLowerCase().replace(/\.+$/, "");
  return domain || null;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

async function fetchIconFrom(
  url: string,
): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const res = await fetch(url, {
    redirect: "follow",
    signal: AbortSignal.timeout(ICON_FETCH_TIMEOUT_MS),
    headers: { "User-Agent": "kill-the-news/1.0" },
  });
  if (!res.ok) return null;

  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.startsWith("image/")) return null;

  const buffer = await res.arrayBuffer();
  if (buffer.byteLength === 0 || buffer.byteLength > MAX_ICON_BYTES)
    return null;

  return { buffer, contentType: contentType.split(";")[0].trim() };
}

async function resolveIcon(
  domain: string,
): Promise<{ buffer: ArrayBuffer; contentType: string } | null> {
  const candidates = [
    `https://${domain}/favicon.ico`,
    `https://icons.duckduckgo.com/ip3/${domain}.ico`,
  ];
  for (const url of candidates) {
    try {
      const icon = await fetchIconFrom(url);
      if (icon) return icon;
    } catch {
      // Try the next candidate; network/timeout errors must never propagate.
    }
  }
  return null;
}

/**
 * Resolve and cache the favicon for a sender domain. Idempotent and never
 * throws: if a (success or negative) cache entry already exists it returns
 * immediately, so callers can fire this on every email without refetching.
 * The KV TTL is the sole expiry mechanism.
 */
export async function cacheFaviconForDomain(
  domain: string,
  env: Env,
): Promise<void> {
  try {
    const key = iconKey(domain);
    const existing = await env.EMAIL_STORAGE.get(key, "text");
    if (existing !== null) return; // present (incl. negative) → nothing to do

    const icon = await resolveIcon(domain);
    const record: IconRecord = icon
      ? {
          data: arrayBufferToBase64(icon.buffer),
          contentType: icon.contentType,
        }
      : { data: null, contentType: "" };

    await env.EMAIL_STORAGE.put(key, JSON.stringify(record), {
      expirationTtl: ICON_TTL_SECONDS,
    });
  } catch (error) {
    logger.warn("Favicon cache failed", { domain, error: String(error) });
  }
}

/**
 * Read a cached icon for a domain. Returns null on a miss or a negative entry.
 */
export async function getCachedIcon(
  domain: string,
  env: Env,
): Promise<{ bytes: ArrayBuffer; contentType: string } | null> {
  const record = (await env.EMAIL_STORAGE.get(
    iconKey(domain),
    "json",
  )) as IconRecord | null;
  if (!record || record.data === null) return null;
  return {
    bytes: base64ToArrayBuffer(record.data),
    contentType: record.contentType,
  };
}
