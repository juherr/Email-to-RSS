import { EmailParser } from "../utils/email-parser";
import { Env } from "../types";
import { processEmail, RawAttachment } from "./email-processor";

export interface ForwardEmailAttachment {
  filename?: string;
  contentType?: string;
  size?: number;
  content?: { type: "Buffer"; data: number[] } | ArrayBuffer | ArrayBufferView;
}

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
  attachments?: ForwardEmailAttachment[];
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

function toArrayBuffer(
  content: ForwardEmailAttachment["content"],
): ArrayBuffer | null {
  if (!content) return null;
  if (content instanceof ArrayBuffer) return content;
  if (ArrayBuffer.isView(content))
    return (content as ArrayBufferView).buffer as ArrayBuffer;
  if (
    typeof content === "object" &&
    content.type === "Buffer" &&
    Array.isArray(content.data)
  ) {
    return Uint8Array.from(content.data).buffer as ArrayBuffer;
  }
  return null;
}

export async function handleForwardEmail(
  payload: ForwardEmailPayload,
  env: Env,
): Promise<Response> {
  const emailData = EmailParser.parseForwardEmailPayload(payload);

  const rawAttachments: RawAttachment[] = (payload.attachments ?? [])
    .map((a) => {
      const buffer = toArrayBuffer(a.content);
      if (!buffer) return null;
      return {
        filename: a.filename || "attachment",
        contentType: a.contentType || "application/octet-stream",
        content: buffer,
      };
    })
    .filter((a): a is RawAttachment => a !== null);

  return processEmail(
    {
      toAddress: payload.recipients?.[0] || "",
      from: emailData.from,
      senders: extractSenderAddresses(payload),
      subject: emailData.subject,
      content: emailData.content,
      receivedAt: emailData.receivedAt,
      headers: emailData.headers,
      attachments: rawAttachments,
    },
    env,
  );
}
