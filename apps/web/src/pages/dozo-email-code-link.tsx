import { Trans } from "@lingui/react/macro";
import "@rakazo/ui-web/dozo-auth.css";
import { useLocation, useNavigate } from "react-router-dom";
import type { AuthCapabilities } from "../lib/auth/auth-capabilities";

/** Whether this server signs in with an emailed code: password sign-in on and a mail sender. */
export function dozoCodeSignInAvailable(capabilities: AuthCapabilities | null | undefined) {
  return Boolean(capabilities?.passwordAuth && capabilities.emailCode);
}

/**
 * The way back from upstream's password form to email-first sign-in (dozo-code-sign-in.tsx),
 * handing over the address typed so far in the history entry, never the URL. Shown only where
 * the server signs in with a code.
 */
export function DozoEmailCodeLink({
  capabilities,
}: {
  capabilities: AuthCapabilities | null | undefined;
}) {
  const navigate = useNavigate();
  const { search } = useLocation();
  if (!dozoCodeSignInAvailable(capabilities)) return null;
  return (
    <button
      type="button"
      data-dozo-quiet
      data-testid="email-me-a-code"
      className="mt-3"
      onClick={(event) => {
        const field = event.currentTarget.form?.elements.namedItem("email");
        const email = field instanceof HTMLInputElement ? field.value.trim() : "";
        navigate(`/sign-in${search}`, { state: { email } });
      }}
    >
      <Trans>Email me a code instead</Trans>
    </button>
  );
}
