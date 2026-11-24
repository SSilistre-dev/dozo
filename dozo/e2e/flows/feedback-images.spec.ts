import { mkdirSync } from "node:fs";
import { APPEARANCE_KEY, readWorld, rpc } from "../fixtures";
import { outDir } from "../scan";
import type { Mail } from "../support";
import { stackReadsMail } from "../support";
import { openAccountMenu, openBot } from "../ui";
import { expect, test } from "./flow";

type Sent = Mail & { attachments?: { filename: string; contentType: string; content: string }[] };

/**
 * A report can carry a screenshot. The person adds it in the feedback dialog, which shows it small
 * with a way to remove it; the server draws it again and mails it to the operator as an attachment.
 * The stack's email emulator holds the mail, so the scenario reads back what the operator got.
 * It needs a stack started with the emulator (`DOZO_EMAIL_EMULATOR=1`), which also sets the inbox.
 */
test("feedback: a screenshot goes to the operator's inbox as an attachment", async ({
  page,
  request,
}) => {
  test.skip(!(await stackReadsMail(request)), "this stack has no email emulator");
  const world = readWorld();
  for (const theme of ["light", "dark"] as const) {
    await page.addInitScript(
      ([key, value]) => localStorage.setItem(key as string, value as string),
      [APPEARANCE_KEY, theme],
    );
    await openBot(page, world.chiefId, "Chief");
    const status = await rpc<{ mode: string | null }>(page, "dozoFeedback/status", undefined);
    test.skip(status.mode !== "send", "this stack mails no feedback");
    const menu = await openAccountMenu(page);
    await menu.getByRole("button", { name: "Send feedback" }).click();
    const dialog = page.getByTestId("dozo-feedback");
    await dialog.getByRole("textbox", { name: "Feedback" }).fill(`The ${theme} screen looks off.`);

    // The page itself is the screenshot: a real PNG of what the person sees.
    const picture = await page.screenshot({ type: "png" });
    await dialog
      .getByTestId("dozo-feedback-file")
      .setInputFiles({ name: "screen.png", mimeType: "image/png", buffer: picture });
    await expect(dialog.locator("img")).toHaveCount(1);
    await expect(dialog.getByRole("button", { name: "Remove image" })).toBeVisible();
    mkdirSync(`${outDir()}/shots`, { recursive: true });
    await page.screenshot({ path: `${outDir()}/shots/feedback-images--${theme}.png` });

    await dialog.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("Sent")).toBeVisible();
  }

  const mails = (await (await request.get("/api/dev/emails")).json()) as Sent[];
  const reports = mails.filter((mail) => mail.subject === "Feedback");
  expect(reports.length).toBeGreaterThanOrEqual(2);
  for (const report of reports.slice(-2)) {
    expect(report.to).toBe("feedback@dozo-e2e.test");
    expect(report.text).toContain("Images: 1");
    expect(report.attachments).toHaveLength(1);
    const [file] = report.attachments ?? [];
    expect([file?.filename, file?.contentType]).toEqual(["screenshot-1.png", "image/png"]);
    // What arrived is a PNG the server drew itself.
    expect(
      Buffer.from(file?.content ?? "", "base64")
        .subarray(1, 4)
        .toString(),
    ).toBe("PNG");
  }
});
