import { Context } from "hono";
import { EmailParser } from "../utils/email-parser";
import { Env } from "../types";
import { processEmail } from "../lib/email-processor";

interface ForwardEmailPayload {
  recipients?: string[];
  from?: {
    value?: Array<{ address?: string; name?: string }>;
    text?: string;
    html?: string;
  };
  subject?: string;
  text?: string;
  html?: string;
  date?: string;
  messageId?: string;
  headerLines?: Array<{ key: string; line: string }>;
  headers?: string;
  raw?: string;
  attachments?: Array<any>;
}

function extractIncomingSenderAddresses(
  payload: ForwardEmailPayload,
): string[] {
  const valueEntries = payload.from?.value || [];
  const structuredAddresses = valueEntries
    .map((entry) => entry.address || "")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);

  if (structuredAddresses.length > 0) {
    return Array.from(new Set(structuredAddresses));
  }

  const fromText = payload.from?.text || "";
  const matches =
    fromText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return Array.from(new Set(matches.map((v) => v.trim().toLowerCase())));
}

export async function handle(c: Context): Promise<Response> {
  try {
    const env = c.env as unknown as Env;
    const payload: ForwardEmailPayload = await c.req.json();

    console.log("Received email:", {
      to: payload.recipients?.[0],
      from: payload.from?.text || "Unknown",
      subject: payload.subject,
      contentType: payload.html ? "HTML" : "Text",
    });

    const emailData = EmailParser.parseForwardEmailPayload(payload);

    return processEmail(
      {
        toAddress: payload.recipients?.[0] || "",
        from: emailData.from,
        senders: extractIncomingSenderAddresses(payload),
        subject: emailData.subject,
        content: emailData.content,
        receivedAt: emailData.receivedAt,
        headers: emailData.headers,
      },
      env,
    );
  } catch (error) {
    console.error("Error processing email:", error);
    return new Response("Error processing email", { status: 500 });
  }
}
