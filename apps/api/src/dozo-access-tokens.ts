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
} from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";
import { resolveThreadTarget } from "./thread-target.js";

function accessTokenDto(row: DozoAccessTokenRow): DozoAccessToken {
  return {
    id: row.id,
    name: row.name,
    botId: row.botId,
    botName: row.botName,
    hint: row.hint,
    createdAt: row.createdAt.toISOString(),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
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
        (await listDozoAccessTokens(deps.prisma, context.actor)).map(accessTokenDto),
      ),
      create: authed.dozoAccessTokens.create.handler(async ({ context, input }) => {
        // Only a bot the member can talk to: the same check a send makes.
        const target = input.botId
          ? await resolveThreadTarget(deps.prisma, context.actor, { botId: input.botId })
          : null;
        const bot = target?.kind === "bot" ? target.bot : null;
        const created = await createDozoAccessToken(deps.prisma, context.actor, {
          name: input.name,
          botId: bot?.id ?? null,
        });
        if (!created)
          throw new ClientError(
            "CONFLICT",
            `You can have ${DOZO_ACCESS_TOKEN_LIMIT} tokens; revoke one first`,
          );
        return {
          token: created.token,
          accessToken: accessTokenDto({ ...created.row, botName: bot?.name ?? null }),
        };
      }),
      revoke: authed.dozoAccessTokens.revoke.handler(async ({ context, input }) => {
        await revokeDozoAccessToken(deps.prisma, context.actor, input.id);
        return { ok: true as const };
      }),
    },
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
