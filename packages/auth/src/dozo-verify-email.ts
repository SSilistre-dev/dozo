import { APIError, getSessionFromCtx } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";

type HookContext = Parameters<typeof getSessionFromCtx>[0];
type InternalAdapter = HookContext["context"]["internalAdapter"];

/** Holds a verification link in the browser that opened it, until that browser signs in. */
export const PENDING_VERIFICATION_COOKIE = "dozo_pending_verification";
/** As long as a verification link lives. */
const PENDING_SECONDS = 60 * 60;

function cookiePath(ctx: HookContext): string {
  return new URL(ctx.context.baseURL).pathname;
}

/**
 * The emailed verification link proves the mailbox, not that whoever opens it holds the account.
 * Opened in a browser signed in to that account, it verifies as before. Opened anywhere else, it
 * verifies nothing and changes nothing: the browser keeps the link and lands on the link's own
 * result page, which asks to sign in, and signing in there finishes the verification
 * (`finishPendingVerification`). Returned as the request's adapter override for `/verify-email`;
 * Better Auth calls `updateUserByEmail` there only to mark an unverified address verified.
 */
export function verifyEmailAdapter(ctx: HookContext): Pick<InternalAdapter, "updateUserByEmail"> {
  const adapter = ctx.context.internalAdapter;
  return {
    updateUserByEmail: async (email, data) => {
      const found = await adapter.findUserByEmail(email);
      // A link opened twice at once finds the account verified the second time: nothing to hold.
      if (found?.user.emailVerified === false) {
        const session = await getSessionFromCtx(ctx);
        if (session?.user.id !== found.user.id) {
          const secure = ctx.context.baseURL.startsWith("https:") ? "; Secure" : "";
          const headers = new Headers({
            "set-cookie": `${PENDING_VERIFICATION_COOKIE}=${ctx.query.token}; Path=${cookiePath(ctx)}; Max-Age=${PENDING_SECONDS}; HttpOnly; SameSite=Lax${secure}`,
          });
          if (ctx.query.callbackURL) {
            headers.set("location", ctx.query.callbackURL);
            throw new APIError("FOUND", undefined, headers);
          }
          throw new APIError("FORBIDDEN", { message: "Sign in to finish verifying" }, headers);
        }
      }
      return adapter.updateUserByEmail(email, data);
    },
  };
}

/**
 * Finishes a verification held by `verifyEmailAdapter` when the browser that opened the link signs
 * in to the account it names: that browser has now shown both the mailbox and the account's own
 * way in. A sign-in to another account, or a link that no longer checks out, verifies nothing.
 */
export async function finishPendingVerification(ctx: HookContext): Promise<void> {
  const token = ctx.getCookie(PENDING_VERIFICATION_COOKIE);
  const user = ctx.context.newSession?.user;
  if (!token || !user) return;
  ctx.setCookie(PENDING_VERIFICATION_COOKIE, "", { path: cookiePath(ctx), maxAge: 0 });
  const link = await verifyJWT<{ email?: unknown; updateTo?: unknown }>(token, ctx.context.secret);
  if (link?.email === user.email.toLowerCase() && link.updateTo === undefined) {
    await ctx.context.internalAdapter.updateUserByEmail(user.email, { emailVerified: true });
  }
}
