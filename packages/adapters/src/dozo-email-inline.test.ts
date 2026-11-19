import nodemailer from "nodemailer";
import { describe, expect, it, vi } from "vitest";
import { ResendEmailProvider } from "./resend-email.js";
import { SmtpEmailProvider } from "./smtp-email.js";

// The rules in dozo/brand/brand.json give both email adapters inline images; this runs on the
// branded tree.
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const mail = {
  to: "ada@example.test",
  subject: "Verify",
  text: "Verify",
  html: '<img src="cid:mark" alt="">',
  inline: [{ contentId: "mark", filename: "mark.png", contentType: "image/png", content: PIXEL }],
};

describe("inline images", () => {
  it("SMTP sends them as related parts the HTML finds by content id", async () => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let raw = "";
    const transport = {
      sendMail: async (options: object) => {
        const info = await stream.sendMail(options);
        raw = String(info.message);
        return info;
      },
      close: () => undefined,
    };
    const provider = new SmtpEmailProvider(
      { url: "smtps://smtp.example.test:465", from: "no-reply@example.test" },
      { transport: transport as never },
    );
    await provider.send(mail);
    expect(raw).toMatch(/Content-Type: multipart\/related/);
    // The plain text part stays, beside the HTML, for clients that show text only.
    expect(raw).toMatch(/Content-Type: multipart\/alternative/);
    expect(raw).toMatch(/Content-Type: text\/plain[\s\S]*\r?\n\r?\nVerify\r?\n/);
    expect(raw).toMatch(/Content-ID: <mark>/);
    expect(raw).toMatch(/Content-Disposition: inline; filename=mark\.png/);
    expect(raw).toContain(PIXEL.slice(0, 40));
  });

  it("SMTP sends a mail without them as before", async () => {
    const sendMail = vi.fn(async (_options: object) => ({ messageId: "m" }));
    const provider = new SmtpEmailProvider(
      { url: "smtps://smtp.example.test:465", from: "no-reply@example.test" },
      { transport: { sendMail } as never },
    );
    await provider.send({ ...mail, inline: undefined });
    expect(sendMail.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("the HTTP adapter sends them as attachments with a content id, not as a field of its own", async () => {
    const fetch = vi.fn(async () => Response.json({ id: "email-1" }));
    const provider = new ResendEmailProvider(
      { apiKey: "key", from: "no-reply@example.test" },
      { fetch: fetch as never },
    );
    await provider.send(mail);
    const sent = (call: number) =>
      JSON.parse(String((fetch.mock.calls[call] as unknown as [string, RequestInit])[1].body));
    const body = sent(0);
    expect(body).not.toHaveProperty("inline");
    expect(body.attachments).toEqual([
      { filename: "mark.png", content: PIXEL, content_type: "image/png", content_id: "mark" },
    ]);
    await provider.send({ ...mail, inline: [] });
    const plain = sent(1);
    expect(plain).not.toHaveProperty("attachments");
    expect(plain).not.toHaveProperty("inline");
  });
});
