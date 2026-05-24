import PostalMime from "postal-mime";
import { Env } from "../types";
import {
  processEmail,
  RawAttachment,
  IngestRejectionReason,
} from "../application/email-processor";
import { bumpCounters } from "../application/stats";
import { normalizeCid } from "../infrastructure/html-processor";
import { logger } from "./logger";

export async function handleCloudflareEmail(
  message: ForwardableEmailMessage,
  env: Env,
  ctx: ExecutionContext,
): Promise<void> {
  try {
    const email = await PostalMime.parse(message.raw);

    const fromAddress = email.from?.address ?? message.from;
    const from =
      email.from?.name && email.from.address
        ? `${email.from.name} <${email.from.address}>`
        : fromAddress;

    const headers: Record<string, string> = {};
    for (const h of email.headers) {
      headers[h.key] = h.value;
    }

    const rawAttachments: RawAttachment[] = (email.attachments ?? [])
      .filter((a) => a.content instanceof ArrayBuffer)
      .map((a) => ({
        filename: a.filename || "attachment",
        contentType: a.mimeType || "application/octet-stream",
        content: a.content as ArrayBuffer,
        contentId: normalizeCid(a.contentId),
      }));

    const result = await processEmail(
      {
        toAddress: message.to,
        from,
        senders: [message.from],
        subject: email.subject ?? "(no subject)",
        content: email.html ?? email.text ?? "",
        receivedAt: email.date ? new Date(email.date).getTime() : Date.now(),
        headers,
        attachments: rawAttachments,
      },
      env,
      ctx,
    );
    if (!result.ok) {
      logger.warn("Inbound email rejected", {
        to: message.to,
        reason: result.reason,
      });
      await maybeForwardFallback(message, env, result.reason);
    }
  } catch (error) {
    console.error("Error processing Cloudflare email:", error);
  }
}

// Reasons safe to forward to the catch-all fallback: the mail was never a feed's
// (wrong address shape, or no such feed). Expired feeds and blocked senders are
// dropped so a real newsletter never leaks into the fallback inbox.
const FORWARDABLE_REASONS = new Set<IngestRejectionReason>([
  "invalid_address",
  "feed_not_found",
]);

async function maybeForwardFallback(
  message: ForwardableEmailMessage,
  env: Env,
  reason: IngestRejectionReason,
): Promise<void> {
  const fallback = env.FALLBACK_FORWARD_ADDRESS;
  if (!fallback || !FORWARDABLE_REASONS.has(reason)) return;

  try {
    await message.forward(fallback);
    // Counted as a subset of emails_rejected (already bumped in processEmail);
    // the dropped count is derived as emails_rejected − emails_forwarded.
    await bumpCounters(env.EMAIL_STORAGE, { emails_forwarded: 1 });
  } catch (error) {
    logger.warn("Fallback forward failed", {
      to: message.to,
      fallback,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
