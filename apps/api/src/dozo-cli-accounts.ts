import { cliHomeConnection, readCliTools } from "@rakazo/adapters";
import { persistModelCredential } from "./model-credentials.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The provider tools on the person's own computer that can run as their models (cli-models in
 * adapters). Only a server the desktop app runs there offers any. A new connection signals only
 * their own apps, on the roster stream.
 */
export function dozoCliAccountsRoutes(ctx: RouterContext) {
  const { deps, authed, codexCatalog } = ctx;
  const cliDeps = { prisma: deps.prisma, secretStore: deps.secrets };
  return {
    dozoCliAccounts: {
      list: authed.dozoCliAccounts.list.handler(async ({ context }) => ({
        tools: await readCliTools(cliDeps, context.actor.userId),
      })),
      connect: authed.dozoCliAccounts.connect.handler(async ({ context, input }) => {
        const connection = await cliHomeConnection(cliDeps, context.actor.userId, input.provider);
        await persistModelCredential(
          deps,
          context.actor,
          { ...connection, credentialId: null, keepExistingDefault: true, signal: context.signal },
          codexCatalog,
        );
        void deps.events?.publishRosterChange?.({ userIds: [context.actor.userId] });
        return { tools: await readCliTools(cliDeps, context.actor.userId) };
      }),
    },
  };
}
