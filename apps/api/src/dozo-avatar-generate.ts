import { randomUUID } from "node:crypto";
import type { MediaGenerationProvider } from "@rakazo/adapter-kit";
import { MediaGenerationError } from "@rakazo/adapter-kit";
import {
  DOZO_MEDIA_USAGE_PROVIDER,
  dozoReserveMediaUsage,
  operatorPaysFor,
  validateGeneratedMedia,
} from "@rakazo/adapters";
import type { Actor, DozoAvatarGenerateReason } from "@rakazo/contracts";
import { DOZO_AVATAR_GENERATE_ERRORS } from "@rakazo/contracts";
import { ClientError, deadlineSignal } from "@rakazo/core";
import { LeaseHeldError, runAsSystem, withLease } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { dozoAvatarForSave } from "./dozo-avatar-upload.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

/** Pictures one person may have drawn in any 24 hours, in all their Spaces together. */
export const DOZO_AVATAR_GENERATE_PER_DAY = 20;
/** The usage records' label for these pictures, apart from a bot's own `generate_image`. */
export const DOZO_AVATAR_USAGE_MODEL = "avatar_image";
/** The longest one picture may take before the person is told to try again. */
const GENERATE_DEADLINE_MS = 120_000;
/** Held while a picture is drawn; renewed in the background, so a crash frees it within this. */
const LEASE_TTL_MS = 30_000;
const DAY_MS = 24 * 60 * 60 * 1000;
/** What goes after the person's words, so any image service draws a picture that fits a circle. */
const FRAMING = "Square profile picture, one centered subject, plain background, no text.";

export type DozoAvatarGenerateWiring = {
  mediaGeneration?: MediaGenerationProvider;
  /** Whether the server bills: only then does the plan decide who may use the image service. */
  billingEnabled: boolean;
};

/** Spread into the router's dependencies where the server builds them. */
export function dozoAvatarGenerateWiring(wiring: DozoAvatarGenerateWiring): {
  dozoAvatarGenerate: DozoAvatarGenerateWiring;
} {
  return { dozoAvatarGenerate: wiring };
}

const REFUSALS: Record<DozoAvatarGenerateReason, () => ClientError> = {
  unavailable: () =>
    new ClientError(
      "NOT_FOUND",
      "Avatars can't be drawn here",
      DOZO_AVATAR_GENERATE_ERRORS.unavailable,
    ),
  plan: () =>
    new ClientError(
      "FORBIDDEN",
      "Drawing avatars isn't included in this plan",
      DOZO_AVATAR_GENERATE_ERRORS.plan,
    ),
  limit: () =>
    new ClientError(
      "TOO_MANY_REQUESTS",
      "Too many avatars today, try again tomorrow",
      DOZO_AVATAR_GENERATE_ERRORS.limit,
    ),
};

const busy = () =>
  new ClientError("CONFLICT", "An avatar is already being drawn", DOZO_AVATAR_GENERATE_ERRORS.busy);

/** The one answer for whatever the image service did wrong: nothing of its own words or the request. */
const failed = () =>
  new ClientError(
    "SERVICE_UNAVAILABLE",
    "Couldn't draw an avatar, try again",
    DOZO_AVATAR_GENERATE_ERRORS.failed,
  );

/** The image service's own failure becomes the general one; anything else is a bug and propagates. */
async function asFailure<T>(work: () => Promise<T> | T): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof MediaGenerationError)) throw error;
    // The reason's code only: the request, and whatever the service said back, stay out of the log.
    getLogger().warn("avatar generation failed", { reason: error.code });
    throw failed();
  }
}

/**
 * Drawing an avatar from a few words. The picture goes through the checks and the 256 px WebP
 * re-encoding an uploaded one does (`dozoAvatarForSave`) and comes back to the app; nothing is
 * saved here, so a picture the person does not use changes nothing. The description is never
 * logged, put in an error or kept in a usage record.
 *
 * The operator pays for each picture, so: Free on a billing server is refused (the plan rule a
 * bot's own image tool follows), `DOZO_AVATAR_GENERATE_PER_DAY` in any sliding 24 hours per person
 * is counted from the usage records (which every instance shares), and a person has one picture
 * being drawn at a time, held by a lease across instances. The count is read under that lease, so
 * two at once cannot both slip past the limit. A picture's one record is written before the
 * service is called and its write is not swallowed: a call that cannot be counted does not start,
 * and one that is cancelled, times out or fails still counts, since the service may have been
 * charged.
 */
export function dozoAvatarGenerateRoutes(
  ctx: RouterContext,
  options: { now?: () => number; deadlineMs?: number } = {},
) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const now = options.now ?? Date.now;
  const wiring = (deps as RouterDeps & { dozoAvatarGenerate?: DozoAvatarGenerateWiring })
    .dozoAvatarGenerate;
  const provider = wiring?.mediaGeneration;

  /** Whether the server can draw for this person at all, before today's count. */
  async function refusal(actor: Actor): Promise<"unavailable" | "plan" | null> {
    if (!wiring || !provider?.capabilities.images) return "unavailable";
    return (await operatorPaysFor({ billingEnabled: wiring.billingEnabled, prisma }, actor))
      ? null
      : "plan";
  }

  // Usage rows are Space-owned, so a count across a person's Spaces is named system work; it
  // reads the number of their own rows and nothing else.
  const drawnToday = (actor: Actor) =>
    runAsSystem("count a person's drawn avatars", () =>
      prisma.usageRecord.count({
        where: {
          userId: actor.userId,
          provider: DOZO_MEDIA_USAGE_PROVIDER,
          model: DOZO_AVATAR_USAGE_MODEL,
          createdAt: { gte: new Date(now() - DAY_MS) },
        },
      }),
    );

  async function draw(
    actor: Actor,
    image: MediaGenerationProvider,
    prompt: string,
    signal: AbortSignal,
  ): Promise<string> {
    if ((await drawnToday(actor)) >= DOZO_AVATAR_GENERATE_PER_DAY) throw REFUSALS.limit();
    const id = `avatar:${randomUUID()}`;
    await dozoReserveMediaUsage(
      prisma,
      { userId: actor.userId, spaceId: actor.spaceId },
      DOZO_AVATAR_USAGE_MODEL,
      id,
    );
    const output = await asFailure(() =>
      image.generateImage(
        { prompt: `${prompt}. ${FRAMING}` },
        { operationId: id, traceId: id, spaceId: actor.spaceId, userId: actor.userId, signal },
      ),
    );
    await asFailure(() => validateGeneratedMedia(output, "image"));
    // The same signature check and re-encoding as an uploaded picture; a refusal is its own.
    return dozoAvatarForSave(
      `data:image/png;base64,${Buffer.from(output.bytes).toString("base64")}`,
    );
  }

  return {
    dozoAvatarGenerate: {
      status: authed.dozoAvatarGenerate.status.handler(async ({ context }) => {
        const reason =
          (await refusal(context.actor)) ??
          ((await drawnToday(context.actor)) >= DOZO_AVATAR_GENERATE_PER_DAY ? "limit" : null);
        return { available: reason === null, reason };
      }),

      generate: authed.dozoAvatarGenerate.generate.handler(async ({ context, input, signal }) => {
        const { actor } = context;
        const reason = await refusal(actor);
        if (reason || !provider) throw REFUSALS[reason ?? "unavailable"]();
        const deadline = deadlineSignal(options.deadlineMs ?? GENERATE_DEADLINE_MS, signal);
        try {
          const image = await withLease(
            prisma,
            `dozo-avatar-generate:${actor.userId}`,
            { ttlMs: LEASE_TTL_MS, signal: deadline },
            (lease) => draw(actor, provider, input.prompt, lease.signal),
          );
          return { image };
        } catch (error) {
          if (error instanceof LeaseHeldError) throw busy();
          // Our own deadline, not the caller leaving: they are told to try again.
          if (deadline.aborted && !signal?.aborted && !(error instanceof ClientError))
            throw failed();
          throw error;
        }
      }),
    },
  };
}
