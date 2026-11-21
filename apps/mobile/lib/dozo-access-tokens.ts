import { ph, t } from "@lingui/core/macro";
import type { DozoAccessToken } from "@rakazo/contracts";

/**
 * The words a token's row adds about its dates, the same lines as the web app's token list.
 * They carry placeholders and no catalog lists them yet, so a release build fills them through
 * the fallback compiler (`dozo-i18n-fallback.ts`).
 */
export function tokenDates(
  token: Pick<DozoAccessToken, "lastUsedAt" | "expiresAt">,
  locale: string,
): { used: string; ends: string | null } {
  const day = (iso: string) => new Date(iso).toLocaleDateString(locale, { dateStyle: "medium" });
  const date = token.lastUsedAt ? day(token.lastUsedAt) : null;
  const ends = token.expiresAt ? day(token.expiresAt) : null;
  return {
    used: date ? t`Last used ${ph({ date })}` : t`Never used`,
    ends: ends ? t`Expires ${ph({ ends })}` : null,
  };
}

/** The question that asks before a token is revoked. */
export function revokeTitle(name: string): string {
  return t`Revoke ${ph({ name })}`;
}
