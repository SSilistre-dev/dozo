import { Trans } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { useEffect, useState } from "react";
import { fetchAuthCapabilities } from "../lib/auth/auth-capabilities";
import { useHostedStart } from "../pages/dozo-hosted-login";
import { SettingsRow } from "./settings/SettingsRows";

/**
 * Settings > General > Security on a computer's own server that still has password accounts: links
 * the signed-in account to the Dozo account (`hostedLink` in the public capabilities), with the
 * same sign-in the hosted page asks to agree to. Once linked, the password goes, and when no
 * password account is left the server signs in only with the Dozo account. Anywhere else, nothing.
 */
export function DozoHostedLinkRow() {
  const [offered, setOffered] = useState(false);
  useEffect(() => {
    let active = true;
    fetchAuthCapabilities().then(
      (capabilities) => {
        if (active) setOffered(capabilities.hostedLink === true);
      },
      () => {
        if (active) setOffered(false);
      },
    );
    return () => {
      active = false;
    };
  }, []);
  // The row's save is made only where it is offered, so settings shown without a query provider
  // still render everywhere else.
  return offered ? <LinkRow /> : null;
}

function LinkRow() {
  const start = useHostedStart(true);
  return (
    <SettingsRow
      label={<Trans>Dozo account</Trans>}
      control={
        <Button variant="ghost" size="sm" disabled={start.pending} onClick={() => start.run()}>
          <Trans>Link</Trans>
        </Button>
      }
    >
      {start.error ? (
        <p role="alert" className="mt-1 text-body text-destructive">
          <Trans>Could not continue</Trans>
        </p>
      ) : null}
    </SettingsRow>
  );
}
