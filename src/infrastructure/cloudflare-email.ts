import PostalMime from "postal-mime";
import { Env } from "../types";
import { processEmail, RawAttachment } from "../application/email-processor";
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
    }
  } catch (error) {
    console.error("Error processing Cloudflare email:", error);
  }
}
