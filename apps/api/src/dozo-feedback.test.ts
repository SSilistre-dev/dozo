import { createRouterClient } from "@orpc/server";
import type { TransactionalEmail } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DOZO_FEEDBACK_PER_HOUR,
  DOZO_FEEDBACK_PER_USER_HOUR,
  dozoFeedbackRoutes,
  feedbackAddress,
} from "./dozo-feedback.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const actor: Actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};
const client = {
  surface: "web" as const,
  userAgent: "Mozilla/5.0 (X11; Linux x86_64) Test/1.0",
  language: "tr-TR",
  timeZone: "Europe/Istanbul",
};

const findRuns = vi.fn();
const send = vi.fn<(mail: TransactionalEmail) => Promise<void>>();

function routes(options: { email?: boolean; gitSha?: string } = {}) {
  const deps = {
    prisma: { run: { findMany: findRuns } },
    email: options.email === false ? undefined : { send },
    env: { gitSha: "gitSha" in options ? options.gitSha : "abc1234" },
  } as unknown as RouterDeps;
  return dozoFeedbackRoutes(createRouterContext(deps), () => NOW);
}

function caller(built = routes(), as: Actor = actor) {
  return createRouterClient(built, { context: { actor: as } });
}

beforeEach(() => {
  vi.stubEnv("DOZO_FEEDBACK_EMAIL", "inbox@operator.example.test");
  findRuns.mockReset().mockResolvedValue([
    { id: "run-2", createdAt: new Date("2026-11-20T11:00:00.000Z") },
    { id: "run-1", createdAt: new Date("2026-11-19T09:30:00.000Z") },
  ]);
  send.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("feedbackAddress", () => {
  it("is the operator's address, or none when unset or not an address", () => {
    expect(feedbackAddress(" inbox@operator.example.test ")).toBe("inbox@operator.example.test");
    expect(feedbackAddress("")).toBeNull();
    expect(feedbackAddress("not an address")).toBeNull();
  });

  it("reads DOZO_FEEDBACK_EMAIL", () => {
    expect(feedbackAddress()).toBe("inbox@operator.example.test");
    vi.stubEnv("DOZO_FEEDBACK_EMAIL", undefined);
    expect(feedbackAddress()).toBeNull();
  });
});

describe("status", () => {
  it("offers nothing and reads nothing without an address", async () => {
    vi.stubEnv("DOZO_FEEDBACK_EMAIL", "");
    expect(await caller().dozoFeedback.status()).toEqual({
      mode: null,
      address: null,
      from: "person@example.test",
      server: { revision: "abc1234", failedRuns: [] },
    });
    expect(findRuns).not.toHaveBeenCalled();
  });

  it("sends through the mail provider and keeps the address to the server", async () => {
    const status = await caller().dozoFeedback.status();
    expect(status).toEqual({
      mode: "send",
      address: null,
      from: "person@example.test",
      server: {
        revision: "abc1234",
        failedRuns: [
          { id: "run-2", at: "2026-11-20T11:00:00.000Z" },
          { id: "run-1", at: "2026-11-19T09:30:00.000Z" },
        ],
      },
    });
    expect(findRuns).toHaveBeenCalledWith({
      where: {
        userId: "user-1",
        spaceId: "space-1",
        status: "failed",
        createdAt: { gte: new Date(NOW - 7 * 24 * 60 * 60 * 1000) },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
      // Ids and times only: a run's error text can quote what the person wrote.
      select: { id: true, createdAt: true },
    });
  });

  it("shares the address to write to when there is no mail provider", async () => {
    const status = await caller(routes({ email: false })).dozoFeedback.status();
    expect(status.mode).toBe("save");
    expect(status.address).toBe("inbox@operator.example.test");
  });
});

describe("send", () => {
  it("mails only the note, as plain text with a fixed subject, replying to the person", async () => {
    await expect(caller().dozoFeedback.send({ message: "  The app froze.  " })).resolves.toEqual({
      sent: true,
    });
    expect(findRuns).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith({
      to: "inbox@operator.example.test",
      replyTo: "person@example.test",
      subject: "Feedback",
      text: "The app froze.\n\n--\nFrom: person@example.test\n",
    });
  });

  it("adds exactly the diagnostics the preview showed, and only the caller's own runs", async () => {
    findRuns.mockResolvedValue([{ id: "run-2", createdAt: new Date("2026-11-20T11:00:00.000Z") }]);
    await caller().dozoFeedback.send({
      message: "Replies stopped.",
      diagnostics: { client, runIds: ["run-2", "someone-elses-run"] },
    });
    expect(findRuns).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: "user-1",
          spaceId: "space-1",
          id: { in: ["run-2", "someone-elses-run"] },
        }),
        select: { id: true, createdAt: true },
      }),
    );
    // The whole body, so nothing else (messages, tokens, other personal data) can be in it.
    expect(send.mock.calls[0]?.[0].text).toBe(
      [
        "Replies stopped.",
        "",
        "--",
        "From: person@example.test",
        "Surface: web",
        "Browser: Mozilla/5.0 (X11; Linux x86_64) Test/1.0",
        "Language: tr-TR",
        "Time zone: Europe/Istanbul",
        "Server revision: abc1234",
        "Failed runs: run-2 (2026-11-20T11:00:00.000Z)",
        "",
      ].join("\n"),
    );
  });

  it("says so when the build or any failed run is unknown", async () => {
    await caller(routes({ gitSha: undefined })).dozoFeedback.send({
      message: "Slow",
      diagnostics: { client, runIds: [] },
    });
    expect(findRuns).not.toHaveBeenCalled();
    const text = send.mock.calls[0]?.[0].text ?? "";
    expect(text).toContain("Server revision: unknown\n");
    expect(text).toContain("Failed runs: none\n");
  });

  it("takes the mobile app's diagnostics and writes its surface under the note", async () => {
    await caller().dozoFeedback.send({
      message: "Crash",
      diagnostics: {
        client: { ...client, surface: "mobile", userAgent: "Dozo ios 26.1" },
        runIds: [],
      },
    });
    const text = send.mock.calls[0]?.[0].text ?? "";
    expect(text).toContain("Surface: mobile\n");
    expect(text).toContain("Browser: Dozo ios 26.1\n");
  });

  it("refuses diagnostics fields the preview does not list", async () => {
    await expect(
      caller().dozoFeedback.send({
        message: "Hi",
        diagnostics: {
          client: { ...client, cookie: "session=secret-token" } as typeof client,
          runIds: [],
        },
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses an empty or oversized note", async () => {
    await expect(caller().dozoFeedback.send({ message: "   " })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(caller().dozoFeedback.send({ message: "x".repeat(4001) })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("gives no reply address for an account made from a chat app", async () => {
    await caller(routes(), { ...actor, email: "tg-1@messaging.invalid" }).dozoFeedback.send({
      message: "Hi",
    });
    const mail = send.mock.calls[0]?.[0];
    expect(mail).not.toHaveProperty("replyTo");
    expect(mail?.text).toContain("From: (no reply address)");
  });

  it("is not there without an address or a mail provider", async () => {
    await expect(
      caller(routes({ email: false })).dozoFeedback.send({ message: "Hi" }),
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    vi.stubEnv("DOZO_FEEDBACK_EMAIL", "");
    await expect(caller().dozoFeedback.send({ message: "Hi" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(send).not.toHaveBeenCalled();
  });

  it("limits each person per hour", async () => {
    const built = routes();
    for (let index = 0; index < DOZO_FEEDBACK_PER_USER_HOUR; index++)
      await caller(built).dozoFeedback.send({ message: `Note ${index}` });
    await expect(caller(built).dozoFeedback.send({ message: "One more" })).rejects.toMatchObject({
      code: "TOO_MANY_REQUESTS",
    });
    // Someone else is not held up by it.
    await caller(built, { ...actor, userId: "user-2" }).dozoFeedback.send({ message: "Mine" });
    expect(send).toHaveBeenCalledTimes(DOZO_FEEDBACK_PER_USER_HOUR + 1);
  });

  it("limits everyone together per hour", async () => {
    const built = routes();
    for (let index = 0; index < DOZO_FEEDBACK_PER_HOUR; index++)
      await caller(built, { ...actor, userId: `user-${index}` }).dozoFeedback.send({
        message: "Hi",
      });
    await expect(
      caller(built, { ...actor, userId: "user-new" }).dozoFeedback.send({ message: "Hi" }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  });
});

describe("pictures", () => {
  // A real one-pixel picture; sharp, which draws it again, is the adapters package's to test.
  const png = async () =>
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
      "base64",
    );
  const url = (type: string, bytes: Uint8Array) =>
    `data:image/${type};base64,${Buffer.from(bytes).toString("base64")}`;
  const refused = { code: "feedback_image", message: "Couldn't use that image" };

  it("attaches each one, drawn again by the server, to the mail to the operator", async () => {
    const one = url("png", await png());
    await caller().dozoFeedback.send({ message: "Look", images: [one, one] });
    const mail = send.mock.calls[0]?.[0];
    expect(mail?.to).toBe("inbox@operator.example.test");
    expect(mail?.attachments?.map((file) => [file.filename, file.contentType])).toEqual([
      ["screenshot-1.png", "image/png"],
      ["screenshot-2.png", "image/png"],
    ]);
    expect(mail?.attachments?.[0]?.content).not.toBe("");
    // The report says how many pictures come with it, and nothing of their content.
    expect(mail?.text).toBe("Look\n\n--\nFrom: person@example.test\nImages: 2\n");
  });

  it("sends a note with no pictures as before, with no attachments", async () => {
    await caller().dozoFeedback.send({ message: "Plain", images: [] });
    expect(send.mock.calls[0]?.[0]).not.toHaveProperty("attachments");
  });

  it("refuses a GIF, an SVG, a file that is not a picture and a header that lies", async () => {
    const good = await png();
    const gif = Buffer.from("GIF89a\u0001\u0000\u0001\u0000", "latin1");
    for (const bad of [
      url("gif", gif),
      url("svg+xml", Buffer.from("<svg onload='x()'/>")),
      url("png", Buffer.from("not a picture")),
      url("jpeg", good),
      "https://example.test/a.png",
    ])
      await expect(
        caller().dozoFeedback.send({ message: "Look", images: [url("png", good), bad] }),
      ).rejects.toMatchObject(refused);
    expect(send).not.toHaveBeenCalled();
  });

  it("refuses more than three pictures, one over its size and all together over theirs", async () => {
    const one = url("png", await png());
    await expect(
      caller().dozoFeedback.send({ message: "Look", images: [one, one, one, one] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    const big = url("png", Buffer.concat([await png(), Buffer.alloc(3 * 1024 * 1024)]));
    await expect(
      caller().dozoFeedback.send({ message: "Look", images: [big] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // Each within its limit, but more than the mail carries together.
    const near = url("png", Buffer.concat([await png(), Buffer.alloc(2.9 * 1024 * 1024)]));
    await expect(
      caller().dozoFeedback.send({ message: "Look", images: [near, near, near] }),
    ).rejects.toMatchObject(refused);
    expect(send).not.toHaveBeenCalled();
  });

  it("counts a report with pictures against the same limits, before it reads them", async () => {
    const built = routes();
    const one = url("png", await png());
    for (let index = 0; index < DOZO_FEEDBACK_PER_USER_HOUR; index++)
      await caller(built).dozoFeedback.send({ message: `Note ${index}`, images: [one] });
    await expect(
      caller(built).dozoFeedback.send({ message: "One more", images: [one] }),
    ).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
    expect(send).toHaveBeenCalledTimes(DOZO_FEEDBACK_PER_USER_HOUR);
    // A refused picture takes a turn too, so refusals cannot be retried without limit.
    await expect(
      caller(built, { ...actor, userId: "user-3" }).dozoFeedback.send({
        message: "Look",
        images: ["data:image/png;base64,AAAA"],
      }),
    ).rejects.toMatchObject(refused);
  });
});
