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

  toString(): string {
    return this.value;
  }
}
