import {
  cancelCliLogin,
  cliHomeConnection,
  readCliTools,
  sendCliLoginCode,
  startCliAccountLogin,
} from "@rakazo/adapters";
import { persistModelCredential } from "./model-credentials.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The provider tools on the person's own computer that can run as their models (cli-models in
 * adapters). Only a server the desktop app runs there offers any. Each change, a sign-in step
 * included, signals only their own apps, on the roster stream.
 */
export function dozoCliAccountsRoutes(ctx: RouterContext) {
  const { deps, authed, codexCatalog } = ctx;
  const cliDeps = { prisma: deps.prisma, secretStore: deps.secrets };
  const changed = (userId: string) => {
    void deps.events?.publishRosterChange?.({ userIds: [userId] });
  };
  const tools = async (userId: string) => ({ tools: await readCliTools(cliDeps, userId) });
  return {
    dozoCliAccounts: {
      list: authed.dozoCliAccounts.list.handler(({ context }) => tools(context.actor.userId)),
      connect: authed.dozoCliAccounts.connect.handler(async ({ context, input }) => {
        const connection = await cliHomeConnection(cliDeps, context.actor.userId, input.provider, {
          consent: input.consent === true,
        });
        await persistModelCredential(
          deps,
          context.actor,
          { ...connection, credentialId: null, keepExistingDefault: true, signal: context.signal },
          codexCatalog,
        );
        changed(context.actor.userId);
        return tools(context.actor.userId);
      }),
      addAccount: authed.dozoCliAccounts.addAccount.handler(async ({ context, input }) => {
        const { actor } = context;
        await startCliAccountLogin(cliDeps, actor.userId, input.provider, {
          // The sign-in ends after this request: the account is saved when the tool says so.
          save: async (connection) => {
            await persistModelCredential(
              deps,
              actor,
              { ...connection, credentialId: null, keepExistingDefault: true },
              codexCatalog,
            );
          },
          changed: () => changed(actor.userId),
        });
        return tools(actor.userId);
      }),
      sendCode: authed.dozoCliAccounts.sendCode.handler(({ context, input }) => {
        sendCliLoginCode(context.actor.userId, input.provider, input.code);
        return tools(context.actor.userId);
      }),
      cancelLogin: authed.dozoCliAccounts.cancelLogin.handler(async ({ context, input }) => {
        await cancelCliLogin(context.actor.userId, input.provider);
        changed(context.actor.userId);
        return tools(context.actor.userId);
      }),
    },
  };
}
