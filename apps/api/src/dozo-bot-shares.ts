import { createHash } from "node:crypto";
import type { Actor, BotTemplate, DozoBotDefinition } from "@rakazo/contracts";
import {
  BotAvatarSetSchema,
  DOZO_BOT_SHARE_DAYS,
  DOZO_BOT_SHARE_KIND,
  DOZO_SHARE_LINK_WEB_PREFIX,
  DozoBotDefinitionSchema,
  isBotAvatarValue,
} from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import type { AgentImportServices } from "./bots/agent-import.js";
import { requestDigest, savedTimeZone, writeImportedBot } from "./bots/agent-import.js";
import { templatePlan } from "./bots/bot-templates.js";
import { botShareKind, ownsBot, readBotShare } from "./dozo-bot-share-kind.js";
import {
  createShareLink,
  listShareLinks,
  readSharedLink,
  revokeShareLink,
} from "./dozo-share-links.js";
import type { RouterContext } from "./routes/context.js";

/** A field of the bot is over the limit a shared bot has. */
export class BotShareTooLargeError extends ClientError {
  constructor(field: string) {
    super("BAD_REQUEST", `Over the limit for sharing: the bot's ${field}`, "BOT_SHARE_TOO_LARGE");
  }
}

/** What would be published, or copied, is no longer what the person was shown. */
export class BotShareChangedError extends ClientError {
  constructor() {
    super("CONFLICT", "This bot changed. Look at it again first", "BOT_SHARE_CHANGED");
  }
}

/** The same text for the same definition, whatever order a stored copy keeps its keys in. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => (left < right ? -1 : 1));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function botShareFingerprint(definition: DozoBotDefinition): string {
  return createHash("sha256").update(canonical(definition)).digest("hex");
}

/**
 * The definition publishing would make public: the bot's name, avatar (an uploaded picture only
 * when included), instructions, description, and its own scheduled routines as name, prompt and
 * schedule. Refused as not found unless the caller owns the bot.
 */
export async function botShareDefinition(
  prisma: Pick<PrismaClient, "bot" | "routine">,
  actor: Actor,
  botId: string,
  includePicture: boolean,
): Promise<{ definition: DozoBotDefinition; hasPicture: boolean }> {
  const bot = await prisma.bot.findFirst({
    where: { id: botId, spaceId: actor.spaceId, userId: actor.userId, archivedAt: null },
    select: { name: true, description: true, instructions: true, color: true, avatarSet: true },
  });
  if (!bot) throw new IsolationError();
  // Another member's routine on this bot holds their words, not the owner's.
  const routines = await prisma.routine.findMany({
    where: { botId, spaceId: actor.spaceId, userId: actor.userId },
    select: { name: true, prompt: true, crons: true },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  const hasPicture = bot.color.startsWith("data:image/");
  const color = isBotAvatarValue(bot.color) && (!hasPicture || includePicture) ? bot.color : null;
  const parsed = DozoBotDefinitionSchema.safeParse({
    name: bot.name,
    avatar: { color, avatarSet: BotAvatarSetSchema.catch("organic").parse(bot.avatarSet) },
    instructions: bot.instructions,
    description: bot.description,
    routines: routines
      .filter((routine) => routine.crons.length > 0)
      .map(({ name, prompt, crons }) => ({ name, prompt, crons })),
  });
  if (!parsed.success) throw new BotShareTooLargeError(String(parsed.error.issues[0]?.path[0]));
  return { definition: parsed.data, hasPicture };
}

/** The live links the caller made to this bot, newest first. */
async function botLinks(prisma: Pick<PrismaClient, "$queryRaw">, actor: Actor, botId: string) {
  return (await listShareLinks(prisma, actor)).filter(
    (link) => link.kind === DOZO_BOT_SHARE_KIND && link.targetId === botId,
  );
}

/**
 * Publishes the definition the owner confirmed: a snapshot of it replaces the bot's earlier one
 * and their links are revoked in the same transaction, so an old link never shows the new text.
 */
export async function publishBotShare(
  prisma: PrismaClient,
  actor: Actor,
  input: { botId: string; includePicture: boolean; fingerprint: string },
) {
  const { definition } = await botShareDefinition(prisma, actor, input.botId, input.includePicture);
  if (botShareFingerprint(definition) !== input.fingerprint) throw new BotShareChangedError();
  await prisma.$transaction(async (tx) => {
    await tx.$queryRaw`
      INSERT INTO dozo_bot_shares ("botId", "userId", "spaceId", "definition")
      VALUES (${input.botId}, ${actor.userId}, ${actor.spaceId}, ${JSON.stringify(definition)}::jsonb)
      ON CONFLICT ("botId") DO UPDATE
        SET "definition" = EXCLUDED."definition", "createdAt" = CURRENT_TIMESTAMP
      RETURNING "botId"`;
    for (const link of await botLinks(tx, actor, input.botId)) {
      await revokeShareLink(tx, actor, link.id);
    }
  });
  return createShareLink(prisma, actor, {
    kind: DOZO_BOT_SHARE_KIND,
    targetId: input.botId,
    days: DOZO_BOT_SHARE_DAYS,
  });
}

/** The bot's newest live link, while something published stands behind it. */
export async function botShareStatus(prisma: PrismaClient, actor: Actor, botId: string) {
  if (!(await ownsBot(prisma, actor, botId))) throw new IsolationError();
  const [link] = await botLinks(prisma, actor, botId);
  const [published] = await prisma.$queryRaw<{ botId: string }[]>`
    SELECT "botId" FROM dozo_bot_shares
    WHERE "botId" = ${botId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}`;
  return { link: link && published ? { id: link.id, expiresAt: link.expiresAt } : null };
}

/** Revokes every link to the bot and deletes what was published; an archived bot's too. */
export async function revokeBotShare(prisma: PrismaClient, actor: Actor, botId: string) {
  if (!(await ownsBot(prisma, actor, botId, { archived: true }))) throw new IsolationError();
  await prisma.$transaction(async (tx) => {
    for (const link of await botLinks(tx, actor, botId)) await revokeShareLink(tx, actor, link.id);
    await tx.$queryRaw`
      DELETE FROM dozo_bot_shares
      WHERE "botId" = ${botId} AND "userId" = ${actor.userId} AND "spaceId" = ${actor.spaceId}
      RETURNING "botId"`;
  });
}

/**
 * The whole definition behind a live link, under every check its signed-out read makes. Any token
 * that does not open a bot's link is not found.
 */
export async function openBotShare(prisma: PrismaClient, token: string) {
  const shared = await readSharedLink(prisma, token, {
    [DOZO_BOT_SHARE_KIND]: { canShare: botShareKind.canShare, load: readBotShare },
  });
  if (!shared) throw new IsolationError();
  const definition = shared.payload as DozoBotDefinition;
  return { definition, fingerprint: botShareFingerprint(definition) };
}

/** The definition as the template path takes one: no skills and no apps. */
function asTemplate(definition: DozoBotDefinition): BotTemplate {
  return {
    id: "shared-bot",
    version: 1,
    name: definition.name,
    summary: definition.name,
    sample: definition.name,
    description: definition.description,
    instructions: definition.instructions,
    skills: [],
    routines: definition.routines,
    apps: [],
  };
}

/** Import keys of copies; the key holds the caller's request id only, never the link or its bot. */
const CLONE_KEY_PREFIX = "dozo-bot-share:";

/**
 * The caller's own bot from a live link, made as a template's bot is: in one transaction, with
 * the plan's checks and limits, and every routine paused. Nothing ties the copy to the link.
 */
export async function cloneBotShare<PreparedKey>(
  services: AgentImportServices<PreparedKey>,
  actor: Actor,
  input: { token: string; fingerprint: string; requestId: string },
  signal?: AbortSignal,
) {
  const { definition, fingerprint } = await openBotShare(services.prisma, input.token);
  if (fingerprint !== input.fingerprint) throw new BotShareChangedError();
  const { bot } = await writeImportedBot(
    services,
    actor,
    {
      importKey: `${CLONE_KEY_PREFIX}${input.requestId}`,
      digest: requestDigest({ requestId: input.requestId }),
      name: definition.name,
      description: definition.description,
      color: definition.avatar.color ?? undefined,
      avatarSet: definition.avatar.avatarSet,
      selection: {
        instructions: ["instructions"],
        memory: [],
        skills: [],
        model: false,
        mcpServers: [],
        routines: definition.routines.map((_, index) => `routine-${index}`),
        apiKeys: [],
        leftovers: [],
      },
      build: async () =>
        templatePlan(asTemplate(definition), await savedTimeZone(services.prisma, actor)),
    },
    signal,
  );
  return { bot };
}

export function dozoBotShareRoutes(ctx: RouterContext) {
  const { deps, authed, agentImportServices } = ctx;
  return {
    dozoBotShares: {
      preview: authed.dozoBotShares.preview.handler(async ({ context, input }) => {
        const shown = await botShareDefinition(
          deps.prisma,
          context.actor,
          input.botId,
          input.includePicture,
        );
        return { ...shown, fingerprint: botShareFingerprint(shown.definition) };
      }),
      publish: authed.dozoBotShares.publish.handler(async ({ context, input }) => {
        const { link, token } = await publishBotShare(deps.prisma, context.actor, input);
        const url = new URL(`${DOZO_SHARE_LINK_WEB_PREFIX}${token}`, deps.env.webOrigin).href;
        return { url, expiresAt: link.expiresAt };
      }),
      status: authed.dozoBotShares.status.handler(({ context, input }) =>
        botShareStatus(deps.prisma, context.actor, input.botId),
      ),
      revoke: authed.dozoBotShares.revoke.handler(async ({ context, input }) => {
        await revokeBotShare(deps.prisma, context.actor, input.botId);
        return { revoked: true as const };
      }),
      open: authed.dozoBotShares.open.handler(({ input }) =>
        openBotShare(deps.prisma, input.token),
      ),
      clone: authed.dozoBotShares.clone.handler(({ context, input }) =>
        cloneBotShare(agentImportServices, context.actor, input, context.signal),
      ),
    },
  };
}
