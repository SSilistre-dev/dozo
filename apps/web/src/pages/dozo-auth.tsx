import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { AuthPage as UpstreamAuthPage } from "./Auth";

/**
 * Upstream's sign-in and sign-up page, for a deployment that may take no new accounts. The server
 * says in its public capabilities whether registration is open. While it is closed the sign-up
 * address shows sign-in, and dozo-shell.css hides the link to sign-up through the attribute set
 * here. Sign-up waits for the answer so a closed deployment never flashes the form. With
 * registration open, or the answer lost, the page is upstream's as it is; upstream reports a
 * failed capabilities request itself.
 */
export function AuthPage(props: ComponentProps<typeof UpstreamAuthPage>) {
  const { search } = useLocation();
  const [signups, setSignups] = useState<"pending" | "open" | "closed">("pending");
  useEffect(() => {
    let active = true;
    fetchAuthCapabilities().then(
      (capabilities) => {
        if (active) setSignups(capabilities.signupsOpen === false ? "closed" : "open");
      },
      () => {
        if (active) setSignups("open");
      },
    );
    return () => {
      active = false;
    };
  }, []);
  if (props.mode === "up" && signups !== "open") {
    return signups === "closed" ? <Navigate to={`/sign-in${search}`} replace /> : null;
  }
  return (
    <div className="contents" data-dozo-signups={signups}>
      <UpstreamAuthPage {...props} />
    </div>
  );
}
