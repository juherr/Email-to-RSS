const BUCKET_MS = 10 * 60 * 1000; // 10-minute window

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function generateCsrfToken(secret: string): Promise<string> {
  const bucket = Math.floor(Date.now() / BUCKET_MS).toString();
  return hmacHex(secret, bucket);
}

export async function verifyCsrfToken(
  secret: string,
  token: string,
): Promise<boolean> {
  if (!token) return false;
  const now = Math.floor(Date.now() / BUCKET_MS);
  // Accept current and previous bucket to handle boundary cases
  for (const bucket of [now, now - 1]) {
    const expected = await hmacHex(secret, bucket.toString());
    if (token === expected) return true;
  }
  return false;
}
