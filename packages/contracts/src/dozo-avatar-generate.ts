import { oc } from "@orpc/contract";
import * as z from "zod";

/** The longest description a person can give: a few words, not a document. */
export const DOZO_AVATAR_PROMPT_MAX_CHARS = 300;

/** Why generating an avatar is not on offer to this person right now. */
export const DozoAvatarGenerateReasonSchema = z.enum(["unavailable", "plan", "limit"]);
export type DozoAvatarGenerateReason = z.infer<typeof DozoAvatarGenerateReasonSchema>;

/**
 * Whether the server can draw an avatar from a description for the caller. `unavailable`: no image
 * service is connected. `plan`: the image service is paid for by the operator and the caller's
 * plan does not include it. `limit`: today's allowance is used up.
 */
export const DozoAvatarGenerateStatusSchema = z.object({
  available: z.boolean(),
  reason: DozoAvatarGenerateReasonSchema.nullable(),
});
export type DozoAvatarGenerateStatus = z.infer<typeof DozoAvatarGenerateStatusSchema>;

export const DozoAvatarGenerateInputSchema = z.object({
  prompt: z.string().trim().min(1).max(DOZO_AVATAR_PROMPT_MAX_CHARS),
});
export type DozoAvatarGenerateInput = z.infer<typeof DozoAvatarGenerateInputSchema>;

/** The picture as the server's own 256 px `data:image/webp;base64,` value. Nothing is saved. */
export const DozoAvatarGenerateResultSchema = z.object({ image: z.string() });
export type DozoAvatarGenerateResult = z.infer<typeof DozoAvatarGenerateResultSchema>;

/**
 * What `generate` refuses with, by `code`. `avatar_image` (a picture that is not a usable image)
 * is the code a rejected upload carries too.
 */
export const DOZO_AVATAR_GENERATE_ERRORS = {
  /** NOT_FOUND: no image service is connected. */
  unavailable: "avatar_generate_unavailable",
  /** FORBIDDEN: the caller's plan does not include it. */
  plan: "avatar_generate_plan",
  /** TOO_MANY_REQUESTS: today's allowance is used up. */
  limit: "avatar_generate_limit",
  /** CONFLICT: this person already has one being drawn. */
  busy: "avatar_generate_busy",
  /** SERVICE_UNAVAILABLE: the image service failed or took too long; trying again is fine. */
  failed: "avatar_generate_failed",
} as const;

export const dozoAvatarGenerateContract = {
  status: oc.output(DozoAvatarGenerateStatusSchema),
  generate: oc.input(DozoAvatarGenerateInputSchema).output(DozoAvatarGenerateResultSchema),
};
