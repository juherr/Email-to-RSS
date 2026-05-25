/**
 * A normalised DNS domain (lowercased, no leading `@`, no trailing dots).
 * Accepts both bare (`example.com`) and allowlist-style (`@example.com`) input.
 */
export class Domain {
  private constructor(readonly value: string) {}

  static parse(raw: string): Domain | null {
    const normalized = raw
      .trim()
      .toLowerCase()
      .replace(/^@+/, "")
      .replace(/\.+$/, "");
    return normalized ? new Domain(normalized) : null;
  }

  matches(other: Domain): boolean {
    return this.value === other.value;
  }

  /**
   * This domain plus each parent domain down to the two-label registrable
   * level, most-specific first: `a.b.example.com` →
   * `[a.b.example.com, b.example.com, example.com]`. Lets a lookup fall back to
   * the apex when a sending subdomain (e.g. `mail.example.com`) hosts no asset
   * of its own. A single-label value is returned unchanged.
   */
  parents(): Domain[] {
    const labels = this.value.split(".");
    const result: Domain[] = [];
    for (let i = 0; i + 2 <= labels.length; i++) {
      result.push(new Domain(labels.slice(i).join(".")));
    }
    return result.length ? result : [this];
  }

  toString(): string {
    return this.value;
  }
}
