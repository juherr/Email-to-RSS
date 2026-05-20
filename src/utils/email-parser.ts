import { EmailData } from "../types";

/**
 * Simple email parser specialized for ForwardEmail.net's webhook format
 */
export class EmailParser {
  /**
   * Extract the feed ID from an email address
   * @param emailAddress The email address (e.g., apple.mountain.42@domain.com)
   * @returns The feed ID or null if not found
   */
  static extractFeedId(emailAddress: string): string | null {
    // Match pattern for noun1.noun2.XY before the @ symbol
    const match = emailAddress.match(/^([a-z]+\.[a-z]+\.\d{2})@/i);
    return match ? match[1] : null;
  }

  /**
   * Parse email data from ForwardEmail.net's webhook payload
   * @param payload ForwardEmail.net webhook payload
   */
  static parseForwardEmailPayload(payload: any): EmailData {
    if (!payload) {
      throw new Error("Missing or invalid webhook payload");
    }

    // Extract the "to" address
    const toAddress = payload.recipients?.[0] || "";

    // Extract the sender information using ForwardEmail's structure
    const fromAddress =
      payload.from?.text ||
      (payload.from?.value?.[0]?.address
        ? `${payload.from.value[0].name || ""} <${payload.from.value[0].address}>`
        : "Unknown Sender");

    // Extract subject
    let subject = payload.subject || "No Subject";
    // Decode any encoded words in the subject
    subject = this.decodeEncodedWords(subject);

    // Get content, preferring HTML over plain text
    const content = payload.html || payload.text || "";

    // Create simple email data object
    return {
      subject,
      from: fromAddress,
      content,
      receivedAt: payload.date ? new Date(payload.date).getTime() : Date.now(),
      headers: this.extractHeaders(payload),
    };
  }

  /**
   * Extract headers from ForwardEmail payload
   */
  private static extractHeaders(payload: any): Record<string, string> {
    const headers: Record<string, string> = {};

    // Extract headers from headerLines if available
    if (payload.headerLines && Array.isArray(payload.headerLines)) {
      payload.headerLines.forEach((h: { key: string; line: string }) => {
        const key = h.key.toLowerCase();
        const value = h.line
          .replace(new RegExp(`^${h.key}:\\s*`, "i"), "")
          .trim();
        headers[key] = value;
      });
    }
    // Or from headers string if provided
    else if (typeof payload.headers === "string") {
      payload.headers.split(/\r?\n/).forEach((line: string) => {
        const match = line.match(/^([^:]+):\s*(.*)$/);
        if (match) {
          headers[match[1].toLowerCase()] = match[2];
        }
      });
    }

    return headers;
  }

  /**
   * Decode RFC 2047 encoded words in headers
   * @param text Text that may contain encoded words like =?UTF-8?Q?Hello_World?=
   */
  static decodeEncodedWords(text: string): string {
    if (!text) return "";

    // Simple RFC 2047 encoded-word decoder
    return text.replace(
      /=\?([^?]+)\?([BQ])\?([^?]+)\?=/gi,
      (_, charset, encoding, text) => {
        if (encoding.toUpperCase() === "B") {
          // Base64 encoding
          try {
            const decoded = atob(text);
            return decoded;
          } catch (e) {
            return text;
          }
        } else if (encoding.toUpperCase() === "Q") {
          // Quoted-printable encoding
          return this.decodeQuotedPrintable(text.replace(/_/g, " "));
        }
        return text;
      },
    );
  }

  /**
   * Decode quoted-printable encoded text
   * @param text Quoted-printable encoded text
   */
  private static decodeQuotedPrintable(text: string): string {
    return text.replace(/=([0-9A-F]{2})/gi, (_, hex) => {
      return String.fromCharCode(parseInt(hex, 16));
    });
  }
}
