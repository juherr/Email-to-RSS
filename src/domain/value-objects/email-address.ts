import { Domain } from "./domain";

/**
 * A normalised email address. `parse` accepts a bare address (`a@b.com`) or a
 * display form (`Name <a@b.com>`), lowercasing the local part and normalising
 * the domain. Returns null when no plausible address can be found.
 */
export class EmailAddress {
  private constructor(
    readonly normalized: string,
    readonly domain: Domain,
  ) {}

  static parse(raw: string): EmailAddress | null {
    const match = raw.match(/([^\s<>@]+)@([^\s<>@]+)/);
    if (!match) return null;
    const domain = Domain.parse(match[2]);
    if (!domain) return null;
    const local = match[1].trim().toLowerCase();
    return new EmailAddress(`${local}@${domain.value}`, domain);
  }

  /**
   * Best-effort website origin implied by the sender's domain
   * (e.g. `https://example.com/`). Used to absolutize relative links in the
   * email body — the sender's site is the only base we can infer.
   */
  siteBaseUrl(): string {
    return `https://${this.domain.value}/`;
  }

  toString(): string {
    return this.normalized;
  }
}
