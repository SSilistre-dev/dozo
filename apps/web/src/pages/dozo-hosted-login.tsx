import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Link, Navigate, useSearchParams } from "react-router-dom";
import { authClient } from "../lib/auth";
import { useSave } from "../lib/query";
import { AuthFrame, submitClass } from "./Auth";

/**
 * Where a Dozo server on the user's own computer sends them to sign in with this account
 * (`packages/auth/src/dozo-hosted-login.ts`). The route signs them in first when needed and comes
 * back here. Nothing is handed over until they agree: the server answers only this page's own
 * request, with the session, and the token goes only to an address on this computer, which the
 * server checks.
 */
export function HostedLoginPage() {
  const [params] = useSearchParams();
  const session = authClient.useSession();
  const audience = params.get("audience") ?? "";
  const back = params.get("return") ?? "";
  const agree = useSave<void, string>({
    save: async () => {
      const response = await fetch("/api/auth/dozo/hosted-login/issue", {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audience, return: back }),
      });
      if (!response.ok) throw new Error(`hosted login answered ${response.status}`);
      return ((await response.json()) as { url: string }).url;
    },
    onSaved: (url) => window.location.assign(url),
    closesScreen: true,
  });
  if (!audience || !back) return <Navigate to="/app" replace />;
  return (
    <AuthFrame
      title={<Trans>Sign in on this computer?</Trans>}
      onSubmit={(event) => {
        event.preventDefault();
        agree.run();
      }}
    >
      <p className="w-full text-center text-body text-muted-foreground">
        {session.data?.user.email}
      </p>
      <Button type="submit" size="lg" disabled={agree.pending} className={submitClass}>
        <Trans>Continue</Trans>
      </Button>
      {agree.error ? (
        <p role="alert" className="mt-3 w-full text-body text-destructive">
          <Trans>Could not continue</Trans>
        </p>
      ) : null}
      <Link to="/app" className="mt-6 font-medium">
        <Trans>Cancel</Trans>
      </Link>
    </AuthFrame>
  );
}
