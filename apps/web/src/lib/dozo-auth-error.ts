import { ph, t } from "@lingui/core/macro";
import type { AuthErrorCopy } from "@rakazo/core";
import { authErrorMessage, MIN_PASSWORD_LENGTH } from "@rakazo/core";

/**
 * The last step of upstream's `authErrorText` (an anchored rule calls this in place of
 * `authErrorMessage`): the auth codes it leaves to the server's English words get copy of their
 * own, request validation still names the field, and anything else is the caller's copy. The
 * server's message is never shown; it goes to the console for whoever is debugging.
 * `apps/mobile/lib/dozo-auth-error.ts` holds the same table for the mobile app.
 */
export function dozoAuthErrorMessage(body: unknown, copy: AuthErrorCopy): string {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const code = typeof record.code === "string" ? record.code : undefined;
  if (code === "VALIDATION_ERROR") return authErrorMessage(body, copy);
  const text =
    codeText(code, copy) ??
    (record.status === 429 ? t`Too many attempts. Try again in a few minutes.` : undefined);
  if (text) return text;
  if (record.message) console.warn("Auth error shown as generic copy:", code, record.message);
  return copy.fallback;
}

function codeText(code: string | undefined, copy: AuthErrorCopy): string | undefined {
  switch (code) {
    case "INVALID_EMAIL_OR_PASSWORD":
      return t`Incorrect email or password`;
    case "INVALID_PASSWORD":
      return t`Incorrect password`;
    case "INVALID_EMAIL":
      return copy.email;
    case "PASSWORD_TOO_SHORT":
      return t`Password must be at least ${ph({ min: MIN_PASSWORD_LENGTH })} characters`;
    case "PASSWORD_COMPROMISED":
      return t`This password appeared in a data breach. Choose another.`;
    case "USER_ALREADY_EXISTS":
    case "USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL":
      return t`An account with this email already exists`;
    case "EMAIL_NOT_VERIFIED":
      return t`Email verification required`;
    case "SESSION_EXPIRED":
    case "SESSION_NOT_FRESH":
      return t`Sign in again`;
    case "INVALID_TOKEN":
    case "TOKEN_EXPIRED":
    case "invalid_token":
    case "token_expired":
      return t`This link is invalid or expired`;
    case "TOO_MANY_REQUESTS":
      return t`Too many attempts. Try again in a few minutes.`;
    case "SOCIAL_ACCOUNT_ALREADY_LINKED":
    case "LINKED_ACCOUNT_ALREADY_EXISTS":
      return t`This account is already linked`;
    case "FAILED_TO_UNLINK_LAST_ACCOUNT":
      return t`Keep at least one way to sign in`;
    case "AUTH_CANCELLED":
      return t`Sign-in cancelled. Try again.`;
    default:
      return undefined;
  }
}
