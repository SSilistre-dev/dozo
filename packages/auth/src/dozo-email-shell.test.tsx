/** @jsxRuntime automatic */
import { render } from "react-email";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DOZO_MARK, DozoFooter, DozoHeader } from "./dozo-email-shell.js";
import {
  accountDeletionEmail,
  identityCodeEmail,
  passwordResetEmail,
  signInCodeEmail,
  verificationEmail,
} from "./email.js";
import { welcomeEmail } from "./welcome-email.js";

afterEach(() => vi.unstubAllEnvs());

describe("DOZO_MARK", () => {
  it("is a 60 px PNG, carried as base64", () => {
    const png = Buffer.from(DOZO_MARK.content, "base64");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(60);
    expect(png.readUInt32BE(20)).toBe(60);
    expect(DOZO_MARK.contentType).toBe("image/png");
  });
});

describe("DozoHeader", () => {
  it("shows the mark from inside the mail beside the wordmark", async () => {
    const html = await render(<DozoHeader />);
    expect(html).toContain(`src="cid:${DOZO_MARK.contentId}"`);
    expect(html).toContain("dozo");
  });
});

describe("DozoFooter", () => {
  it("links the English policies and names the operator", async () => {
    const html = await render(<DozoFooter locale="en" />);
    expect(html).toContain('href="https://dozo.bot/privacy/"');
    expect(html).toContain('href="https://dozo.bot/terms/"');
    expect(html).toContain('href="mailto:info@ssilistre.dev"');
    expect(html).toContain("SSilistre.dev");
    expect(html).not.toContain("unsubscribe");
  });

  it("links the Turkish policies in Turkish, with the unsubscribe link first", async () => {
    const html = await render(
      <DozoFooter
        locale="tr"
        unsubscribe={{ href: "https://app.example.com/unsubscribe", label: "Abonelikten çık" }}
      />,
    );
    expect(html).toContain('href="https://dozo.bot/tr/privacy/"');
    expect(html).toContain("Gizlilik");
    expect(html).toContain("Koşullar");
    expect(html.indexOf("Abonelikten")).toBeLessThan(html.indexOf("Gizlilik"));
  });

  it("falls back to English for other languages", async () => {
    const html = await render(<DozoFooter locale="ja" />);
    expect(html).toContain("Privacy");
  });
});

// The rules in dozo/brand/brand.json put the shell into upstream's mails; this runs on the branded tree.
describe("branded account mail", () => {
  it("carries the Dozo header, footer and palette in html and plain text", async () => {
    const mail = await signInCodeEmail("ada@example.com", "123456", "tr");
    expect(mail.html).toContain(`src="cid:${DOZO_MARK.contentId}"`);
    expect(mail.inline).toEqual([DOZO_MARK]);
    expect(mail.html).toContain("#1F1F1F");
    expect(mail.html).not.toContain("Arial, Helvetica, sans-serif;");
    expect(mail.text).toContain("Gizlilik https://dozo.bot/tr/privacy/");
    expect(mail.text).toContain("info@ssilistre.dev");
  });

  it("escapes a hostile code and name, and links nothing but the footer", async () => {
    const hostile = '<script>alert(1)</script><a href="https://evil.example">x</a>';
    const footerLinks = 3; // privacy, terms, contact
    for (const mail of [
      await signInCodeEmail("ada@example.com", hostile),
      await accountDeletionEmail("ada@example.com", hostile),
      await identityCodeEmail("ada@example.com", hostile),
    ]) {
      expect(mail.html).not.toContain("<script>");
      expect(mail.html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(mail.html).not.toContain('evil.example">');
      expect((mail.html ?? "").split("<a ").length - 1).toBe(footerLinks);
      expect(mail.text).toContain("<script>alert(1)</script>");
    }
    const reset = await passwordResetEmail(
      { id: "u1", email: "ada@example.com", name: hostile },
      "https://app.example.com/reset",
    );
    expect(reset.html).not.toContain("<script>");
    expect(reset.html).not.toContain('href="https://evil.example"');
  });

  it("keeps the unsubscribe link and header of a marketing mail", async () => {
    const mail = await welcomeEmail(
      { email: "ada@example.com", name: "Ada" },
      "https://app.example.com/unsubscribe",
    );
    expect(mail.text).toContain("Unsubscribe https://app.example.com/unsubscribe");
    expect(mail.headers?.["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe>");
  });

  it("loads no image from anywhere: every image is inside the mail", async () => {
    for (const mail of [
      await signInCodeEmail("ada@example.com", "123456"),
      await accountDeletionEmail("ada@example.com", "123456", "tr"),
      await identityCodeEmail("ada@example.com", "123456"),
      await verificationEmail("ada@example.com", "https://app.example.com/verify", "tr"),
      await passwordResetEmail(
        { id: "u1", email: "ada@example.com", name: "Ada" },
        "https://app.example.com/reset",
      ),
      await welcomeEmail(
        { email: "ada@example.com", name: "Ada" },
        "https://app.example.com/unsubscribe",
      ),
    ]) {
      const sources = [...(mail.html ?? "").matchAll(/<img[^>]*\ssrc="([^"]*)"/g)].map((m) => m[1]);
      expect(sources).toEqual([`cid:${DOZO_MARK.contentId}`]);
      expect(mail.html).not.toMatch(/url\(/);
      expect(mail.inline).toEqual([DOZO_MARK]);
    }
  });

  it("says in the verification mail what the link is for and warns under the button", async () => {
    const en = await verificationEmail("ada@example.com", "https://app.example.com/v", "en");
    expect(en.subject).toBe("Verify your Dozo email");
    const enText = en.text ?? "";
    expect(enText).toContain("Verify the email address for your Dozo account.");
    expect(enText).toContain(
      "If you did not create this account, do not click the button and ignore this email.",
    );
    expect(enText).toContain("This link expires in one hour.");
    expect(enText).not.toContain("Then return");
    expect(enText.indexOf("Verify email")).toBeLessThan(enText.indexOf("If you did not create"));
    const tr = await verificationEmail("ada@example.com", "https://app.example.com/v", "tr");
    expect(tr.subject).toBe("Dozo e-posta adresinizi doğrulayın");
    const trText = tr.text ?? "";
    expect(trText).toContain("Dozo hesabınızın e-posta adresini doğrulayın.");
    expect(trText).toContain(
      "Bu hesabı siz oluşturmadıysanız düğmeye tıklamayın ve bu e-postayı yok sayın.",
    );
    expect(trText).toContain("Bu bağlantının süresi bir saat içinde dolar.");
    expect(trText).not.toContain("Ardından");
    expect(trText.indexOf("hesabınızın")).toBeLessThan(trText.indexOf("E-postayı doğrula"));
    // The warning is body text, not the muted fine print.
    expect(tr.html).not.toMatch(/class="email-muted"[^>]*>Bu hesabı siz/);
  });
});
