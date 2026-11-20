import { readDozoModelPool, setDozoModelPool } from "@rakazo/adapters";
import { recordAuditEvent } from "@rakazo/db";
import type { RouterContext } from "./routes/context.js";

/**
 * The signed-in person's model pool (dozo-model-pool-settings.ts in adapters): which of their own
 * connections hand a run over to each other when one runs out. A change is recorded in the
 * activity log and signals only their own apps, on the roster stream.
 */
export function dozoModelPoolRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const poolDeps = { prisma: deps.prisma, secretStore: deps.secrets };
  return {
    dozoModelPool: {
      get: authed.dozoModelPool.get.handler(({ context }) =>
        readDozoModelPool(poolDeps, context.actor.userId),
      ),
      set: authed.dozoModelPool.set.handler(async ({ context, input }) => {
        const { pool, provider } = await setDozoModelPool(poolDeps, context.actor.userId, input);
        await recordAuditEvent({
          action: "model.pool.changed",
          actor: { type: "user", id: context.actor.userId },
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          target: { type: "model_provider", id: provider },
          metadata: { pooled: input.pooled },
        });
        void deps.events?.publishRosterChange?.({ userIds: [context.actor.userId] });
        return pool;
      }),
    },
  };
}
