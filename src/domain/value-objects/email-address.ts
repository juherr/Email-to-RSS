import { Domain } from "./domain";

/**
 * A normalised email address. `parse` accepts a bare address (`a@b.com`) or a
 * display form (`Name <a@b.com>`), lowercasing the local part and normalising
 * the domain. When the input carries a display name it is captured (verbatim,
 * not normalised — names are case-sensitive). Returns null when no plausible
 * address can be found.
 */
export class EmailAddress {
  private constructor(
    readonly normalized: string,
    readonly domain: Domain,
    /** The sender's display name from a `Name <addr>` input, if any. */
    readonly displayName?: string,
  ) {}

  static parse(raw: string): EmailAddress | null {
    const match = raw.match(/([^\s<>@]+)@([^\s<>@]+)/);
    if (!match) return null;
    const domain = Domain.parse(match[2]);
    if (!domain) return null;
    const local = match[1].trim().toLowerCase();
    const displayName =
      raw.match(/^\s*(.+?)\s*<[^>]+>\s*$/)?.[1].trim() || undefined;
    return new EmailAddress(`${local}@${domain.value}`, domain, displayName);
  }

  /**
   * The best human-readable label for this sender: the display name when the
   * address came in `Name <addr>` form, else the normalised address.
   */
  label(): string {
    return this.displayName ?? this.normalized;
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
