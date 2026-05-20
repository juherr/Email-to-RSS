import PostalMime from "postal-mime";
import { Env } from "../types";
import { processEmail } from "./email-processor";

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

    await processEmail(
      {
        toAddress: message.to,
        from,
        senders: [message.from],
        subject: email.subject ?? "(no subject)",
        content: email.html ?? email.text ?? "",
        receivedAt: email.date ? new Date(email.date).getTime() : Date.now(),
        headers,
      },
      env,
    );
  } catch (error) {
    console.error("Error processing Cloudflare email:", error);
  }
}
