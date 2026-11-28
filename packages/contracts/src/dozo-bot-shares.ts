import { oc } from "@orpc/contract";
import * as z from "zod";
import {
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_INSTRUCTIONS_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BotSchema,
} from "./bots/bot.js";
import { BotAvatarSetSchema, BotAvatarValueSchema } from "./bots/bot-avatar.js";
import { Id, IsoDate } from "./ids.js";
import { ROUTINE_NAME_MAX_LENGTH } from "./routines/routine.js";

/** The share-link kind of a bot's published definition. */
export const DOZO_BOT_SHARE_KIND = "bot";
/** How long a bot's link lives; publishing again makes a new one. */
export const DOZO_BOT_SHARE_DAYS = 30;

/** Every field's limit, checked when the owner publishes and again when someone makes a copy. */
export const DOZO_BOT_SHARE_LIMITS = {
  routines: 10,
  routinePrompt: 4000,
  crons: 5,
  cron: 100,
} as const;

/** What the signed-out page shows of the instructions: the first lines, cut to this much. */
const EXCERPT_LINES = 4;
const EXCERPT_CHARS = 400;

/**
 * Characters a reader cannot see but a model reads: format characters (zero-width, bidi
 * embeddings, overrides and isolates, tags), the whole tag block, and control characters other
 * than newline and tab.
 */
const HIDDEN = /[\p{Cf}\u{E0000}-\u{E007F}]|[^\P{Cc}\n\t]/u;

/** One form for every text: NFC, with line ends as newlines. What is shown is what is stored. */
export function dozoBotShareText(text: string): string {
  return text.normalize("NFC").replace(/\r\n?/g, "\n");
}

/** Every text field of a definition, by the name a refusal gives it. */
function textFields(definition: {
  name: string;
  instructions: string;
  description: string;
  routines: readonly { name: string; prompt: string; crons: readonly string[] }[];
}): [string, string][] {
  return [
    ["name", definition.name],
    ["instructions", definition.instructions],
    ["description", definition.description],
    ...definition.routines.flatMap((routine): [string, string][] => [
      ["routine name", routine.name],
      ["routine prompt", routine.prompt],
      ...routine.crons.map((cron): [string, string] => ["routine schedule", cron]),
    ]),
  ];
}

/** The first field holding text a reader cannot see, or one not in its one form; null if none. */
export function dozoBotShareHiddenField(
  definition: Parameters<typeof textFields>[0],
): string | null {
  const found = textFields(definition).find(
    ([, text]) => HIDDEN.test(text) || text !== dozoBotShareText(text),
  );
  return found ? found[0] : null;
}

const SharedRoutineSchema = z.strictObject({
  name: z.string().min(1).max(ROUTINE_NAME_MAX_LENGTH),
  prompt: z.string().min(1).max(DOZO_BOT_SHARE_LIMITS.routinePrompt),
  crons: z
    .array(z.string().min(1).max(DOZO_BOT_SHARE_LIMITS.cron))
    .min(1)
    .max(DOZO_BOT_SHARE_LIMITS.crons),
});

const SharedAvatarSchema = z.strictObject({
  /** A colour or shape; an uploaded picture only when its owner chose to include it. */
  color: BotAvatarValueSchema.nullable(),
  avatarSet: BotAvatarSetSchema,
});

/**
 * Everything a published bot carries, and nothing else: no memory, history, files, secrets,
 * connections, model, computer, access or approval settings, skills, or anything about its owner.
 * Strict, so a stored definition with any other field is refused.
 */
export const DozoBotDefinitionSchema = /* @__PURE__ */ (() =>
  z
    .strictObject({
      name: z.string().min(1).max(BOT_NAME_MAX_LENGTH),
      avatar: SharedAvatarSchema,
      instructions: z.string().max(BOT_INSTRUCTIONS_MAX_LENGTH),
      /** How other bots see it. */
      description: z.string().max(BOT_DESCRIPTION_MAX_LENGTH),
      routines: z.array(SharedRoutineSchema).max(DOZO_BOT_SHARE_LIMITS.routines),
    })
    .refine((definition) => dozoBotShareHiddenField(definition) === null, {
      message: "Holds characters a reader cannot see",
    }))();
export type DozoBotDefinition = z.infer<typeof DozoBotDefinitionSchema>;

/** What anyone holding the link sees, signed out. Drawn as text only. */
export const DozoBotSharePublicSchema = /* @__PURE__ */ (() =>
  z.strictObject({
    name: z.string(),
    avatar: SharedAvatarSchema,
    instructionsExcerpt: z.string(),
    routineNames: z.array(z.string()),
  }))();
export type DozoBotSharePublic = z.infer<typeof DozoBotSharePublicSchema>;

/** The first lines of the instructions, for the signed-out page. */
export function dozoBotShareExcerpt(instructions: string): string {
  const lines = instructions.trim().split(/\r?\n/).slice(0, EXCERPT_LINES).join("\n").trimEnd();
  return lines.length > EXCERPT_CHARS ? `${lines.slice(0, EXCERPT_CHARS).trimEnd()}…` : lines;
}

export function dozoBotSharePublic(definition: DozoBotDefinition): DozoBotSharePublic {
  return {
    name: definition.name,
    avatar: definition.avatar,
    instructionsExcerpt: dozoBotShareExcerpt(definition.instructions),
    routineNames: definition.routines.map((routine) => routine.name),
  };
}

/** A link's token as `/s/<token>` carries it. */
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
/** Of the definition the person was shown, so a change in between is refused, not applied. */
const Fingerprint = z.string().regex(/^[a-f0-9]{64}$/);

const Shown = z.object({ definition: DozoBotDefinitionSchema, fingerprint: Fingerprint });

/** The owner publishes, checks and revokes a bot's link; a signed-in person opens and copies one. */
export const dozoBotSharesContract = /* @__PURE__ */ (() => ({
  /**
   * What publishing would make public, exactly. `hasPicture` says the bot has an uploaded picture
   * the owner may include. Refused as not found unless the caller owns the bot, as
   * `BOT_SHARE_TOO_LARGE` when a field is over its limit, and as `BOT_SHARE_HIDDEN_TEXT` when one
   * holds characters a reader cannot see.
   */
  preview: oc
    .input(z.object({ botId: Id, includePicture: z.boolean() }))
    .output(Shown.extend({ hasPicture: z.boolean() })),
  /**
   * Publishes what `preview` showed, as a snapshot, behind a new link; the bot's earlier links are
   * revoked. `BOT_SHARE_CHANGED` when the bot changed since the preview.
   */
  publish: oc
    .input(z.object({ botId: Id, includePicture: z.boolean(), fingerprint: Fingerprint }))
    .output(z.object({ url: z.string().url(), expiresAt: IsoDate })),
  /** The bot's live link, if any. Refused as not found unless the caller owns the bot. */
  status: oc
    .input(z.object({ botId: Id }))
    .output(z.object({ link: z.object({ id: Id, expiresAt: IsoDate }).nullable() })),
  /** Revokes the bot's links and deletes what was published. */
  revoke: oc.input(z.object({ botId: Id })).output(z.object({ revoked: z.literal(true) })),
  /**
   * The whole definition behind a live link, shown before a copy is made. Limited per person a
   * minute (`BOT_SHARE_OPEN_LIMIT`), with copies.
   */
  open: oc.input(z.object({ token: Token })).output(Shown),
  /**
   * Makes the caller's own bot from a live link in the current Space, as a template would, with
   * every routine paused. The same `requestId` returns the bot it already made.
   */
  clone: oc
    .input(z.object({ token: Token, fingerprint: Fingerprint, requestId: z.string().uuid() }))
    .output(z.object({ bot: BotSchema })),
}))();
