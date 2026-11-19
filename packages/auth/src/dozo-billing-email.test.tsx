import { describe, expect, it } from "vitest";
import {
  billingEmailLocale,
  cancellationEmail,
  paymentFailedEmail,
  planEndingEmail,
} from "./dozo-billing-email.js";

const BILLING = "https://app.example.com/app?settings=billing";
const reader = (locale: string) => ({ email: "ada@example.com", name: "Ada", locale });
const END = new Date("2026-12-09T12:00:00.000Z");

describe("billing mails", () => {
  it("are written in Turkish for a Turkish reader and in English for anyone else", () => {
    expect(billingEmailLocale("tr")).toBe("tr");
    expect(billingEmailLocale("de")).toBe("en");
    expect(billingEmailLocale("en")).toBe("en");
  });

  it("say a payment failed and lead to billing, without an unsubscribe link", async () => {
    const mail = await paymentFailedEmail(reader("en"), "Premium", BILLING);
    expect(mail.subject).toBe("Your Dozo payment didn't go through");
    expect(mail.text).toContain("Hi Ada,");
    expect(mail.text).toContain(
      "Your last payment for Premium didn't go through. Update your payment method to keep your plan.",
    );
    expect(mail.html).toContain(BILLING);
    expect(mail.html).toContain("Manage billing");
    expect(mail.html).not.toContain("Unsubscribe");
    expect(mail.headers).toBeUndefined();
  });

  it("say it in Turkish", async () => {
    const mail = await paymentFailedEmail(reader("tr"), "Premium", BILLING);
    expect(mail.subject).toBe("Dozo ödemeniz alınamadı");
    expect(mail.text).toContain("Merhaba Ada,");
    expect(mail.text).toContain(
      "Premium için son ödemeniz alınamadı. Planınızı korumak için ödeme yönteminizi güncelleyin.",
    );
    expect(mail.html).toContain("Faturalandırmayı yönet");
    expect(mail.html).toContain('lang="tr"');
  });

  it("say which day a plan ends and what follows it", async () => {
    const plan = { name: "Premium Plus", endsAt: END, next: "Free" };
    const english = await planEndingEmail(reader("en"), plan, BILLING);
    expect(english.subject).toBe("Your Premium Plus plan ends on December 9, 2026");
    expect(english.text).toContain("On December 9, 2026 your account moves to Free.");
    const turkish = await planEndingEmail(reader("tr"), plan, BILLING);
    expect(turkish.subject).toBe("Premium Plus planınız 9 Aralık 2026 tarihinde bitiyor");
    expect(turkish.text).toContain("9 Aralık 2026 tarihinde hesabınız Free planına geçecek.");
  });

  it("confirm a cancellation with the day the plan lasts until", async () => {
    const plan = { name: "Premium", endsAt: END };
    const english = await cancellationEmail(reader("en"), plan, BILLING);
    expect(english.subject).toBe("Your Dozo subscription is canceled");
    expect(english.text).toContain("You keep Premium until December 9, 2026.");
    const turkish = await cancellationEmail(reader("tr"), plan, BILLING);
    expect(turkish.subject).toBe("Dozo aboneliğiniz iptal edildi");
    expect(turkish.text).toContain("9 Aralık 2026 tarihine kadar Premium planınız devam eder.");
  });
});
