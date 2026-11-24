import type { TransactionalEmail } from "@rakazo/adapter-kit";
import { encodeFeedbackImage } from "@rakazo/adapters";
import type { DozoServerDiagnostics } from "@rakazo/contracts";
import {
  DOZO_FEEDBACK_IMAGES_MAX_BYTES,
  DOZO_FEEDBACK_MAX_RUNS,
  dozoFeedbackText,
} from "@rakazo/contracts";
import { ClientError, deadlineSignal, MESSAGING_EMAIL_SUFFIX, withAbort } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import * as z from "zod";
import type { RouterContext } from "./routes/context.js";
import { windowCounter } from "./window-counter.js";

/** Reports one member may send an hour. */
export const DOZO_FEEDBACK_PER_USER_HOUR = 5;
/** Reports this process sends an hour for everyone together, so a flood cannot fill the inbox. */
export const DOZO_FEEDBACK_PER_HOUR = 60;
/** How far back the failed runs a report names may go. */
const RUNS_SINCE_MS = 7 * 24 * 60 * 60 * 1000;
const SEND_DEADLINE_MS = 15_000;
const HOUR_MS = 60 * 60 * 1000;

const Email = z.string().email();

/** A picture that is not a PNG, JPEG or WebP the server can read, or that is over a limit. */
export class FeedbackImageError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Couldn't use that image", "feedback_image");
  }
}

/**
 * The pictures to attach: each checked from its own bytes and drawn again by the server, so no
 * location or device data travels. They go into the mail and nowhere else: not stored, not logged.
 */
async function feedbackImages(values: readonly string[]) {
  // A data URL is base64: four characters per three bytes.
  const bytes = values.reduce((sum, value) => sum + (value.length * 3) / 4, 0);
  if (bytes > DOZO_FEEDBACK_IMAGES_MAX_BYTES) throw new FeedbackImageError();
  const images = await Promise.all(values.map((value, index) => encodeFeedbackImage(value, index)));
  const drawn = images.map((image) => {
    if (!image) throw new FeedbackImageError();
    return image;
  });
  // A picture can come out larger than it went in, and the mail has its own size limit.
  const sent = drawn.reduce((sum, image) => sum + (image.content.length * 3) / 4, 0);
  if (sent > DOZO_FEEDBACK_IMAGES_MAX_BYTES) throw new FeedbackImageError();
  return drawn;
}

/** The operator's inbox for feedback (`DOZO_FEEDBACK_EMAIL`); unset or not an address, none. */
export function feedbackAddress(value = process.env.DOZO_FEEDBACK_EMAIL): string | null {
  const address = value?.trim();
  return address && Email.safeParse(address).success ? address : null;
}

/** Where a reply reaches the caller: their address, unless it stands in for a chat-app account. */
function replyAddress(email: string): string | null {
  return Email.safeParse(email).success && !email.toLowerCase().endsWith(MESSAGING_EMAIL_SUFFIX)
    ? email
    : null;
}

/** The caller's own latest failed runs in this Space: ids and times, never what they said. */
async function failedRuns(
  prisma: PrismaClient,
  actor: { userId: string; spaceId: string },
  now: number,
  only?: readonly string[],
): Promise<DozoServerDiagnostics["failedRuns"]> {
  const runs = await prisma.run.findMany({
    where: {
      userId: actor.userId,
      spaceId: actor.spaceId,
      status: "failed",
      createdAt: { gte: new Date(now - RUNS_SINCE_MS) },
      ...(only ? { id: { in: [...only] } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: DOZO_FEEDBACK_MAX_RUNS,
    select: { id: true, createdAt: true },
  });
  return runs.map((run) => ({ id: run.id, at: run.createdAt.toISOString() }));
}

/**
 * In-app feedback. It goes to the operator's own address by the server's mail provider; without
 * one, the person saves the report and writes to the address themselves. Only the note, the
 * pictures the person added and, when asked for, the diagnostics the preview showed leave the server. The limits are per process, so
 * with several API instances each counts on its own.
 */
export function dozoFeedbackRoutes(ctx: RouterContext, now: () => number = Date.now) {
  const { deps, authed } = ctx;
  const perUser = windowCounter(HOUR_MS, now);
  const total = windowCounter(HOUR_MS, now);
  const revision = () => deps.env?.gitSha ?? null;
  return {
    dozoFeedback: {
      status: authed.dozoFeedback.status.handler(async ({ context }) => {
        const address = feedbackAddress();
        const mode = address ? (deps.email ? "send" : "save") : null;
        return {
          mode,
          address: mode === "save" ? address : null,
          from: replyAddress(context.actor.email),
          server: {
            revision: revision(),
            failedRuns: mode ? await failedRuns(deps.prisma, context.actor, now()) : [],
          },
        };
      }),

      send: authed.dozoFeedback.send.handler(async ({ context, input }) => {
        const address = feedbackAddress();
        if (!address || !deps.email) throw new ClientError("NOT_FOUND", "Feedback is not set up");
        if (perUser(`user:${context.actor.userId}`) > DOZO_FEEDBACK_PER_USER_HOUR)
          throw new ClientError("TOO_MANY_REQUESTS", "Too many reports, try again later");
        if (total("all") > DOZO_FEEDBACK_PER_HOUR)
          throw new ClientError("TOO_MANY_REQUESTS", "Too many reports, try again later");
        const from = replyAddress(context.actor.email);
        const images = await feedbackImages(input.images ?? []);
        const diagnostics = input.diagnostics
          ? {
              ...input.diagnostics.client,
              revision: revision(),
              failedRuns: input.diagnostics.runIds.length
                ? await failedRuns(deps.prisma, context.actor, now(), input.diagnostics.runIds)
                : [],
            }
          : null;
        const mail: TransactionalEmail = {
          to: address,
          ...(from ? { replyTo: from } : {}),
          subject: "Feedback",
          text: dozoFeedbackText(input.message, from, diagnostics, images.length),
          ...(images.length ? { attachments: images } : {}),
        };
        await withAbort(
          deps.email.send(mail),
          deadlineSignal(SEND_DEADLINE_MS),
          "Feedback send timed out",
        );
        return { sent: true as const };
      }),
    },
  };
}
