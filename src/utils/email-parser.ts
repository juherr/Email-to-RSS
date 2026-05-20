import { EmailData } from "../types";

export class EmailParser {
  // Matches noun1.noun2.XY (the feed ID format) before the @ symbol
  static extractFeedId(emailAddress: string): string | null {
    const match = emailAddress.match(/^([a-z]+\.[a-z]+\.\d{2})@/i);
    return match ? match[1] : null;
  }

  static parseForwardEmailPayload(payload: any): EmailData {
    if (!payload) {
      throw new Error("Missing or invalid webhook payload");
    }

    const fromAddress =
      payload.from?.text ||
      (payload.from?.value?.[0]?.address
        ? `${payload.from.value[0].name || ""} <${payload.from.value[0].address}>`
        : "Unknown Sender");

    const subject = this.decodeEncodedWords(payload.subject || "No Subject");
    const content = payload.html || payload.text || "";

    return {
      subject,
      from: fromAddress,
      content,
      receivedAt: payload.date ? new Date(payload.date).getTime() : Date.now(),
      headers: this.extractHeaders(payload),
    };
  }

  private static extractHeaders(payload: any): Record<string, string> {
    const headers: Record<string, string> = {};

    if (payload.headerLines && Array.isArray(payload.headerLines)) {
      payload.headerLines.forEach((h: { key: string; line: string }) => {
        const key = h.key.toLowerCase();
        const value = h.line
          .replace(new RegExp(`^${h.key}:\\s*`, "i"), "")
          .trim();
        headers[key] = value;
      });
    } else if (typeof payload.headers === "string") {
      payload.headers.split(/\r?\n/).forEach((line: string) => {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) {
          headers[match[1].toLowerCase()] = match[2];
        }
      });
    }

    return headers;
  }

  static decodeEncodedWords(text: string): string {
    if (!text) return "";

    return text.replace(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_, charset, encoding, text) => {
        if (encoding.toUpperCase() === "B") {
          try {
            return atob(text);
          } catch (e) {
            return text;
          }
        } else if (encoding.toUpperCase() === "Q") {
          return this.decodeQuotedPrintable(text.replace(/_/g, " "));
        }
        return text;
      },
    );
  }

  private static decodeQuotedPrintable(text: string): string {
    return text.replace(/=([0-9A-F]{2})/gi, (_, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
}
