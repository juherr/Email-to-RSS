import { Env } from "../types";

// Returns the attachment bucket only when the feature is enabled, so callers can
// narrow cleanly. Attachments are on whenever R2 is bound, unless explicitly
// turned off with ATTACHMENTS_ENABLED="false".
export function getAttachmentBucket(env: Env): R2Bucket | undefined {
  if (env.ATTACHMENTS_ENABLED === "false") return undefined;
  return env.ATTACHMENT_BUCKET;
}
