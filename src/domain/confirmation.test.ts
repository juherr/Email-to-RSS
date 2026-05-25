import { describe, it, expect } from "vitest";
import { detectConfirmation } from "./confirmation";

describe("detectConfirmation", () => {
  it("detects an English confirmation email and returns the confirm link", () => {
    const result = detectConfirmation({
      subject: "Please confirm your subscription",
      text: "Click the button below to verify your email address.",
      links: [
        {
          href: "https://news.example.com/confirm?token=abc123",
          text: "Confirm subscription",
        },
        { href: "https://news.example.com/home", text: "Home" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result![0]).toBe("https://news.example.com/confirm?token=abc123");
  });

  it("detects a French confirmation email (accent-insensitive)", () => {
    const result = detectConfirmation({
      subject: "Confirmez votre inscription",
      text: "Cliquez pour activer votre abonnement.",
      links: [
        {
          href: "https://lettre.example.fr/valider/xyz",
          text: "Valider mon inscription",
        },
      ],
    });
    expect(result).not.toBeNull();
    expect(result![0]).toBe("https://lettre.example.fr/valider/xyz");
  });

  it("returns null for a normal newsletter with only an unsubscribe link", () => {
    const result = detectConfirmation({
      subject: "This week in tech",
      text: "Here are the top stories. To stop receiving these, unsubscribe here.",
      links: [
        { href: "https://news.example.com/article/42", text: "Read more" },
        {
          href: "https://news.example.com/unsubscribe?u=9",
          text: "Unsubscribe",
        },
      ],
    });
    expect(result).toBeNull();
  });

  it("returns null when no candidate link is present even if the subject matches", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "Reply to this email to confirm.",
      links: [],
    });
    expect(result).toBeNull();
  });

  it("never treats an unsubscribe link as a confirmation candidate", () => {
    const result = detectConfirmation({
      subject: "Confirm your email",
      text: "Verify your address.",
      links: [
        { href: "https://x.example/verify/abc", text: "Verify email" },
        { href: "https://x.example/unsubscribe", text: "unsubscribe" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!).not.toContain("https://x.example/unsubscribe");
  });

  it("ranks the strongest candidate first and caps at three links", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "verify activate",
      links: [
        { href: "https://x.example/help", text: "help" },
        { href: "https://x.example/a?token=1", text: "click" },
        { href: "https://x.example/confirm?token=2", text: "Confirm" },
        { href: "https://x.example/activate", text: "Activate account" },
        { href: "https://x.example/verify", text: "Verify" },
      ],
    });
    expect(result).not.toBeNull();
    expect(result!.length).toBeLessThanOrEqual(3);
    expect(result![0]).toBe("https://x.example/confirm?token=2");
  });

  it("ignores non-http(s) links", () => {
    const result = detectConfirmation({
      subject: "Confirm your subscription",
      text: "verify",
      links: [{ href: "mailto:confirm@x.example", text: "confirm" }],
    });
    expect(result).toBeNull();
  });
});
