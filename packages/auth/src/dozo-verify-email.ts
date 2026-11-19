import { getSessionFromCtx } from "better-auth/api";

type HookContext = Parameters<typeof getSessionFromCtx>[0];
type InternalAdapter = HookContext["context"]["internalAdapter"];

/**
 * The emailed verification link proves the mailbox, not the logins added to the account before
 * it. Opened in a browser signed in to that account, it proves both, and everything stays. Opened
 * anywhere else, the account keeps only what the mailbox proves, as a sign-in code leaves it: the
 * password, linked logins and sessions go, and the owner signs in with a code or sets a password
 * through a reset. Returned as the request's adapter override for `/verify-email`; Better Auth
 * calls `updateUserByEmail` there only to mark an unverified address verified.
 */
export function verifyEmailAdapter(
  ctx: HookContext,
  revokeStoredCredentials: (userId: string) => Promise<void>,
): Pick<InternalAdapter, "updateUserByEmail"> {
  const adapter = ctx.context.internalAdapter;
  return {
    updateUserByEmail: async (email, data) => {
      const found = await adapter.findUserByEmail(email);
      // A link opened twice at once finds the account verified the second time: it keeps all.
      if (found?.user.emailVerified === false) {
        const userId = found.user.id;
        const session = await getSessionFromCtx(ctx);
        if (session?.user.id !== userId) {
          for (const account of await adapter.findAccounts(userId)) {
            await adapter.deleteAccount(account.id);
          }
          await adapter.deleteUserSessions(userId);
          await revokeStoredCredentials(userId);
        }
      }
      return adapter.updateUserByEmail(email, data);
    },
  };
}
