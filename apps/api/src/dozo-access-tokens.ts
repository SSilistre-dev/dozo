import { dozoBotTokenTainted } from "@rakazo/adapters";
import { emailBanned } from "@rakazo/auth";
import type { Actor, DozoAccessToken } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { DozoAccessTokenRow, PrismaClient } from "@rakazo/db";
import {
  createDozoAccessToken,
  DOZO_ACCESS_TOKEN_LIMIT,
  findDozoAccessToken,
  listDozoAccessTokens,
  looksLikeDozoAccessToken,
  revokeDozoAccessToken,
  runAsSystem,
  trustDozoBot,
} from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { dozoTokenOwnBots, dozoTokenReachesBot } from "./dozo-token-bots.js";
import { requireIdentityConfirmation } from "./auth/identity-confirmation.js";
import type { RouterContext } from "./routes/context.js";
import { resolveThreadTarget } from "./threads/thread-target.js";

function accessTokenDto(row: DozoAccessTokenRow): DozoAccessToken {
  return {
    id: row.id,
    name: row.name,
    botId: row.botId,
    botName: row.botName,
    hint: row.hint,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

/**
 * The signed-in member's access tokens in the current Space, for settings. Only a session reaches
 * these: a token is never accepted on the app's RPC, so it cannot list, make or revoke tokens.
 * Making and revoking one is in the activity log (security-audit.ts).
 */
export function dozoAccessTokensRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    dozoAccessTokens: {
      list: authed.dozoAccessTokens.list.handler(async ({ context }) =>
        // As the system, so the account's password changes (security events, which a member cannot
        // read) leave out the tokens they revoked; the query names the member's own tokens only.
        (
          await runAsSystem("list a member's access tokens", () =>
            listDozoAccessTokens(deps.prisma, context.actor),
          )
        ).map(accessTokenDto),
      ),
      ownBots: authed.dozoAccessTokens.ownBots.handler(({ context }) =>
        dozoTokenOwnBots(deps.prisma, context.actor),
      ),
      create: authed.dozoAccessTokens.create.handler(async ({ context, input }) => {
        // A token outlives the session that makes it, so that session must have just confirmed it is
        // the person: a session taken over cannot quietly leave one behind.
        await requireIdentityConfirmation(deps.auth, context);
        // Only a bot the member can talk to: the same check a send makes.
        const target = input.botId
          ? await resolveThreadTarget(deps.prisma, context.actor, { botId: input.botId })
          : null;
        const bot = target?.kind === "bot" ? target.bot : null;
        // And only one the member made: a token never reaches another member's bot in a shared
        // Space (dozo-token-bots.ts), so it is not made for one either.
        if (bot && !(await dozoTokenReachesBot(deps.prisma, context.actor, null, bot.id)))
          throw new ClientError("NOT_FOUND", "Bot not found");
        const created = await createDozoAccessToken(deps.prisma, context.actor, {
          name: input.name,
          botId: bot?.id ?? null,
          expiresAt:
            input.expiresInDays === null
              ? null
              : new Date(Date.now() + input.expiresInDays * DAY_MS),
        });
        if (!created)
          throw new ClientError(
            "CONFLICT",
            `You can have ${DOZO_ACCESS_TOKEN_LIMIT} tokens; revoke one first`,
          );
        // The account's address hears of every new token, so one made without them is noticed.
        if (deps.email)
          void bestEffort(
            "access token notice",
            deps.email.send(accessTokenNotice(context.actor.email, input.name, bot?.name ?? null)),
          );
        return {
          token: created.token,
          accessToken: accessTokenDto({ ...created.row, botName: bot?.name ?? null }),
        };
      }),
      botMark: authed.dozoAccessTokens.botMark.handler(async ({ context, input }) => {
        const target = await resolveThreadTarget(deps.prisma, context.actor, {
          botId: input.botId,
        });
        if (target.kind !== "bot") return { marked: false };
        return {
          marked: await dozoBotTokenTainted(deps.prisma, {
            botId: target.botId,
            threadId: target.threadId,
          }),
        };
      }),
      trustBot: authed.dozoAccessTokens.trustBot.handler(async ({ context, input }) => {
        // Lifting the mark is the owner's own act, from a session that just confirmed it is them.
        await requireIdentityConfirmation(deps.auth, context);
        const target = await resolveThreadTarget(deps.prisma, context.actor, {
          botId: input.botId,
        });
        if (target.kind !== "bot") throw new ClientError("NOT_FOUND", "Bot not found");
        await trustDozoBot(deps.prisma, {
          spaceId: context.actor.spaceId,
          botId: target.botId,
          userId: context.actor.userId,
        });
        return { ok: true as const };
      }),
      revoke: authed.dozoAccessTokens.revoke.handler(async ({ context, input }) => {
        await revokeDozoAccessToken(deps.prisma, context.actor, input.id);
        return { ok: true as const };
      }),
    },
  };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** The mail that tells an account a token was made for it. Plain words, no link to follow. */
export function accessTokenNotice(to: string, name: string, botName: string | null) {
  const reach = botName ? `the bot ${botName}` : "your bots";
  return {
    to,
    subject: "A new access token for your Dozo account",
    text: [
      `An access token named "${name}" was made for your account. It can send messages to ${reach} and read whatever they can read: their chats, files, memory and connected apps.`,
      "If you did not make it, revoke it in Settings > General > Security > Access tokens and change your password.",
    ].join("\n\n"),
  };
}

/** Who a token speaks for: the member in the token's Space, and the one bot it may reach, if any. */
export type DozoTokenCaller = { tokenId: string; actor: Actor; botId: string | null };

/**
 * Reads `Authorization: Bearer <token>` and nothing else: never a cookie, so a page on another
 * site cannot call the API with the browser's session, and never the address, where a token would
 * end up in logs. A token of a deactivated or banned account, or one revoked, answers null.
 */
export function dozoTokenAuthenticator(prisma: PrismaClient) {
  return async (authorization: string | undefined): Promise<DozoTokenCaller | null> => {
    const match = /^Bearer ([^\s]+)$/i.exec(authorization ?? "");
    const token = match?.[1];
    if (!token || !looksLikeDozoAccessToken(token)) return null;
    return runAsSystem("authenticate a bot API access token", async () => {
      const owner = await findDozoAccessToken(prisma, token);
      if (!owner || owner.deactivated) return null;
      if (await emailBanned(prisma, owner.email)) return null;
      return {
        tokenId: owner.id,
        botId: owner.botId,
        actor: {
          userId: owner.userId,
          spaceId: owner.spaceId,
          email: owner.email,
          isDeploymentOwner: false,
        },
      };
    });
  };
}
