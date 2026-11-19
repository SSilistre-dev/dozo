/** @jsxRuntime automatic */
import { render } from "react-email";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DozoFooter, DozoHeader, markUrl } from "./dozo-email-shell.js";
import { signInCodeEmail } from "./email.js";
import { welcomeEmail } from "./welcome-email.js";

afterEach(() => vi.unstubAllEnvs());

describe("markUrl", () => {
  it("loads the mark from the server's own public https origin", () => {
    expect(markUrl("https://app.example.com/")).toBe("https://app.example.com/icon-192.png");
  });

  it("reads the origin from WEB_ORIGIN", () => {
    vi.stubEnv("WEB_ORIGIN", "https://app.example.com");
    expect(markUrl()).toBe("https://app.example.com/icon-192.png");
  });

  it.each([
    undefined,
    "",
    "not a url",
    "http://app.example.com",
    "https://localhost:5173",
    "https://127.0.0.1",
    "https://[::1]:8080",
  ])("has no mark for %s", (origin) => {
    expect(markUrl(origin)).toBeNull();
  });
});

describe("DozoHeader", () => {
  it("shows the mark beside the wordmark", async () => {
    const html = await render(<DozoHeader mark="https://app.example.com/icon-192.png" />);
    expect(html).toContain('src="https://app.example.com/icon-192.png"');
    expect(html).toContain("dozo");
  });

  it("shows the wordmark alone without a mark", async () => {
    const html = await render(<DozoHeader mark={null} />);
    expect(html).not.toContain("<img");
    expect(html).toContain("dozo");
  });
});

describe("DozoFooter", () => {
  it("links the English policies and names the operator", async () => {
    const html = await render(<DozoFooter locale="en" />);
    expect(html).toContain('href="https://dozo-site.ssilistre.dev/privacy/"');
    expect(html).toContain('href="https://dozo-site.ssilistre.dev/terms/"');
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
    expect(html).toContain('href="https://dozo-site.ssilistre.dev/tr/privacy/"');
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
    vi.stubEnv("WEB_ORIGIN", "https://app.example.com");
    const mail = await signInCodeEmail("ada@example.com", "123456", "tr");
    expect(mail.html).toContain('src="https://app.example.com/icon-192.png"');
    expect(mail.html).toContain("#1F1F1F");
    expect(mail.html).not.toContain("Arial, Helvetica, sans-serif;");
    expect(mail.text).toContain("Gizlilik https://dozo-site.ssilistre.dev/tr/privacy/");
    expect(mail.text).toContain("info@ssilistre.dev");
  });

  it("keeps the unsubscribe link and header of a marketing mail", async () => {
    const mail = await welcomeEmail(
      { email: "ada@example.com", name: "Ada" },
      "https://app.example.com/unsubscribe",
    );
    expect(mail.text).toContain("Unsubscribe https://app.example.com/unsubscribe");
    expect(mail.headers?.["List-Unsubscribe"]).toBe("<https://app.example.com/unsubscribe>");
  });
});
