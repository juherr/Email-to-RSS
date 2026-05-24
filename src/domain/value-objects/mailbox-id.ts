import { nouns } from "../../data/nouns";

// Inbound mailbox ids are noun1.noun2.XY (two lowercase nouns + a 2-digit suffix).
const MAILBOX_IN_ADDRESS = /^([a-z]+\.[a-z]+\.\d{2})@/i;

/**
 * A feed's inbound mailbox identifier — the friendly `noun.noun.NN` local part of
 * the address newsletters are sent to (`<mailboxId>@domain`). It is deliberately
 * NOT the feed's identity: a `MailboxId` resolves to a `FeedId` through the
 * `inbound:` index at reception, so the public read URL (the opaque `FeedId`) and
 * the inbound address stay decoupled.
 *
 * `parse` pulls it from an untrusted inbound address (the most untrusted input in
 * the system); `generate` mints a fresh one. The original casing is preserved.
 */
export class MailboxId {
  private constructor(readonly value: string) {}

  /** Extract the mailbox id from an inbound address (`noun.noun.NN@domain`). */
  static parse(emailAddress: string): MailboxId | null {
    const match = emailAddress.match(MAILBOX_IN_ADDRESS);
    return match ? new MailboxId(match[1]) : null;
  }

  /**
   * Wrap a string as a MailboxId WITHOUT revalidating it. The caller asserts the
   * value originated from our own minting (a stored `mailbox_id`). Untrusted
   * external input (an inbound address) must go through `parse` instead.
   */
  static unchecked(value: string): MailboxId {
    return new MailboxId(value);
  }

  static generate(): MailboxId {
    const noun1 = nouns[Math.floor(Math.random() * nouns.length)];
    const noun2 = nouns[Math.floor(Math.random() * nouns.length)];
    const number = Math.floor(Math.random() * 90) + 10;
    return new MailboxId(`${noun1}.${noun2}.${number}`);
  }

  /** The full inbound email address (`<mailboxId>@<domain>`) newsletters target. */
  emailAddress(domain: string): string {
    return `${this.value}@${domain}`;
  }

  toString(): string {
    return this.value;
  }
}
