/** Encode bytes as unpadded base64url (URL- and KV-key-safe). */
function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * A feed's identity: the KV storage key AND the public read id in `/rss/:feedId`
 * etc. It is an opaque, high-entropy random token — unguessable, so a feed's read
 * URL can be shared without revealing its inbound address (the `MailboxId`, a
 * separate value that resolves here via the `inbound:` index at reception).
 *
 * `generate` mints a fresh token; `unchecked` wraps a route param or stored key
 * without revalidation (a wrong id simply misses in KV and 404s downstream).
 */
export class FeedId {
  private constructor(readonly value: string) {}

  /**
   * Wrap a string as a FeedId WITHOUT revalidating it. The caller asserts the id
   * originated from our own minting — a route param echoing a stored id, a
   * `feeds:list` entry, an `inbound:` index value, or a KV key. The name is
   * deliberately blunt: a wrong id is not rejected here, it simply misses in KV
   * and 404s downstream.
   */
  static unchecked(value: string): FeedId {
    return new FeedId(value);
  }

  /** Mint a fresh, opaque identity (128 bits of entropy → 22 base64url chars). */
  static generate(): FeedId {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    return new FeedId(base64url(bytes));
  }

  toString(): string {
    return this.value;
  }
}
