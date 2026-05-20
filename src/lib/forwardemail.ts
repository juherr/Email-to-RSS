import { EmailParser } from "../utils/email-parser";
import { Env } from "../types";
import { processEmail } from "./email-processor";

export interface ForwardEmailPayload {
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

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

function extractSenderAddresses(payload: ForwardEmailPayload): string[] {
  const valueEntries = payload.from?.value || [];
  const structuredAddresses = valueEntries
    .map((entry) => entry.address || "")
    .map(normalizeEmail)
    .filter(Boolean);

  if (structuredAddresses.length > 0) {
    return Array.from(new Set(structuredAddresses));
  }

  const fromText = payload.from?.text || "";
  const matches =
    fromText.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi) || [];
  return Array.from(new Set(matches.map(normalizeEmail)));
}

export async function handleForwardEmail(
  payload: ForwardEmailPayload,
  env: Env,
): Promise<Response> {
  const emailData = EmailParser.parseForwardEmailPayload(payload);

  return processEmail(
    {
      toAddress: payload.recipients?.[0] || "",
      from: emailData.from,
      senders: extractSenderAddresses(payload),
      subject: emailData.subject,
      content: emailData.content,
      receivedAt: emailData.receivedAt,
      headers: emailData.headers,
    },
    env,
  );
}
