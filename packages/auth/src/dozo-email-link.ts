import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { TransactionalEmailProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import type { BetterAuthPlugin } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { EmailLocaleOf } from "./email.js";
import { verificationEmail } from "./email.js";

/**
 * The verification mail, sent the way the reset mail is: in the background, so the answer to
 * whoever asked takes the same time and says the same thing whether the address has an
 * unverified account, a verified one or none, and whether delivery works. An anchored rule in
 * `dozo/brand/brand.json` puts it in place of upstream's hook.
 *
 * The link comes back to the web app's result page (`apps/web/src/pages/dozo-email-link.tsx`)
 * with a mark instead of the address: the mark names the account, signed with the server's
 * secret, so the page can ask whether that account is verified and which address to fill in,
 * and no address travels in a URL. The auth library appends `error=<code>` when the link did not
 * verify. A page without a valid mark never says "verified" on the server's behalf.
 */

const MARK_CONTEXT = "dozo-email-link:";
/** How long the result page may ask about the account: long after the link itself expires. */
export const MARK_LIFETIME_SECONDS = 7 * 24 * 60 * 60;

/** Mails one address may receive per hour, whoever asks and from wherever. */
export const VERIFICATION_MAILS_PER_HOUR = 3;
const HOUR_MS = 60 * 60 * 1000;

function sign(secret: string, payload: string): Buffer {
  return createHmac("sha256", secret)
    .update(MARK_CONTEXT + payload)
    .digest();
}

export function linkMark(secret: string, userId: string, now = Date.now()): string {
  const payload = `${Buffer.from(userId).toString("base64url")}.${Math.floor(now / 1000) + MARK_LIFETIME_SECONDS}`;
  return `${payload}.${sign(secret, payload).toString("base64url")}`;
}

/** The account a mark names, or null when it is not one this server signed or it has expired. */
export function readLinkMark(secret: string, mark: string, now = Date.now()): string | null {
  const parts = mark.split(".");
  if (parts.length !== 3) return null;
  const [id = "", expires = "", signature = ""] = parts;
  const given = Buffer.from(signature, "base64url");
  const wanted = sign(secret, `${id}.${expires}`);
  if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) return null;
  if (!/^\d+$/.test(expires) || Number(expires) * 1000 < now) return null;
  return Buffer.from(id, "base64url").toString() || null;
}

/** Where a verification link lands once the server has checked it. */
export function verificationCallbackUrl(
  webOrigin: string,
  secret: string,
  userId: string,
  now = Date.now(),
): string {
  const url = new URL("/verify-email", webOrigin);
  url.searchParams.set("v", linkMark(secret, userId, now));
  return url.href;
}

type Limiter = Pick<PrismaClient, "$queryRaw">;

/**
 * Counts one verification mail to `email` and says whether it may go: at most
 * `VERIFICATION_MAILS_PER_HOUR` an hour per address. The count lives in the auth library's own
 * `rateLimit` table (one row per address, keyed by a hash so the address is not stored), updated
 * in one statement, so every API instance shares it.
 */
export async function takeVerificationMail(
  prisma: Limiter,
  email: string,
  now = Date.now(),
): Promise<boolean> {
  const key = `dozo-verification-mail:${createHash("sha256").update(email.trim().toLowerCase()).digest("hex")}`;
  const windowStart = BigInt(now - HOUR_MS);
  const at = BigInt(now);
  const rows = await prisma.$queryRaw<{ count: number }[]>`
    INSERT INTO "rateLimit" ("id", "key", "count", "lastRequest")
    VALUES (${randomUUID()}, ${key}, 1, ${at})
    ON CONFLICT ("key") DO UPDATE SET
      "count" = CASE WHEN "rateLimit"."lastRequest" <= ${windowStart} THEN 1 ELSE "rateLimit"."count" + 1 END,
      "lastRequest" = CASE WHEN "rateLimit"."lastRequest" <= ${windowStart} THEN ${at} ELSE "rateLimit"."lastRequest" END
    RETURNING "count"`;
  return Number(rows[0]?.count ?? Number.POSITIVE_INFINITY) <= VERIFICATION_MAILS_PER_HOUR;
}

export type VerificationMailDeps = {
  prisma: Limiter;
  email: TransactionalEmailProvider;
  secret: string;
  webOrigin: string;
  localeOf: EmailLocaleOf;
  onError?: (error: unknown) => void;
};

/**
 * Sends one verification mail unless the address had its share this hour. Never rejects: a
 * failure goes to `onError`, the caller does not wait for it.
 */
export async function sendVerificationMail(
  deps: VerificationMailDeps,
  user: { id: string; email: string },
  url: string,
  headers?: Headers | null,
): Promise<void> {
  try {
    if (!(await takeVerificationMail(deps.prisma, user.email))) return;
    const link = new URL(url);
    link.searchParams.set(
      "callbackURL",
      verificationCallbackUrl(deps.webOrigin, deps.secret, user.id),
    );
    const locale = await deps.localeOf({ id: user.id }, headers);
    await deps.email.send(await verificationEmail(user.email, link.href, locale));
  } catch (error) {
    deps.onError?.(error);
  }
}

/**
 * `GET /dozo/email-link?v=<mark>`: whether the account a result page's mark names is verified,
 * and its address for the page's form. Any mark that does not check out, or names no account,
 * gets the same empty answer.
 */
export function dozoEmailLink(): BetterAuthPlugin {
  return {
    id: "dozo-email-link",
    endpoints: {
      dozoEmailLink: createAuthEndpoint("/dozo/email-link", { method: "GET" }, async (ctx) => {
        const mark = typeof ctx.query?.v === "string" ? ctx.query.v : "";
        const userId = mark ? readLinkMark(ctx.context.secret, mark) : null;
        const user = userId ? await ctx.context.internalAdapter.findUserById(userId) : null;
        return ctx.json(
          user
            ? { verified: user.emailVerified === true, email: user.email }
            : { verified: false, email: null },
        );
      }),
    },
  };
}
