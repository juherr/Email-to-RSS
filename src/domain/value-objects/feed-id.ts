import { nouns } from "../../data/nouns";

// Feed IDs are noun1.noun2.XY (two lowercase nouns + a 2-digit suffix).
const FEED_ID_IN_ADDRESS = /^([a-z]+\.[a-z]+\.\d{2})@/i;

/**
 * A feed identifier. `parse` pulls it from the local part of an inbound email
 * address; `generate` mints a fresh one. The original casing is preserved.
 */
export class FeedId {
  private constructor(readonly value: string) {}

  /** Extract the feed id from an inbound address (`noun.noun.NN@domain`). */
  static parse(emailAddress: string): FeedId | null {
    const match = emailAddress.match(FEED_ID_IN_ADDRESS);
    return match ? new FeedId(match[1]) : null;
  }

  /**
   * Wrap a string as a FeedId WITHOUT revalidating it. The caller asserts the id
   * originated from our own minting — a route param echoing a stored id, a
   * `feeds:list` entry, or an email/KV key. The name is deliberately blunt: a
   * wrong id is not rejected here, it simply misses in KV and 404s downstream.
   * Untrusted external input (an inbound address) must go through `parse` instead.
   */
  static unchecked(value: string): FeedId {
    return new FeedId(value);
  }

  static generate(): FeedId {
    const noun1 = nouns[Math.floor(Math.random() * nouns.length)];
    const noun2 = nouns[Math.floor(Math.random() * nouns.length)];
    const number = Math.floor(Math.random() * 90) + 10;
    return new FeedId(`${noun1}.${noun2}.${number}`);
  }

  toString(): string {
    return this.value;
  }
}
