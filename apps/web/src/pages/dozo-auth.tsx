import { Trans, useLingui } from "@lingui/react/macro";
import { signInProviders } from "@rakazo/contracts";
import { APP_LOCALE_LABELS } from "@rakazo/core";
import { Button, OptionSelect } from "@rakazo/ui-web";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import type { AuthCapabilities } from "../lib/auth/auth-capabilities";
import { fetchAuthCapabilities } from "../lib/auth/auth-capabilities";
import { planIntentFromParams, savePlanIntent } from "../lib/dozo-plan-intent";
import { markSignupStarted } from "../lib/dozo-signup-start";
import { getActiveUiLocale, setUiLocale } from "../lib/locale/i18n";
import type { UiLocale } from "../lib/locale/ui-locale";
import { UI_LOCALES } from "../lib/locale/ui-locale";
import { AuthFrame, submitClass, AuthPage as UpstreamAuthPage } from "./auth/Auth";
import { DozoCodeSignIn } from "./dozo-code-sign-in";
import { dozoCodeSignInAvailable } from "./dozo-email-code-link";
import { HostedSignIn } from "./dozo-hosted-login";

/**
 * Upstream's sign-in and sign-up page, for a deployment that may take no new accounts. The server
 * says in its public capabilities whether registration is open. While it is closed the sign-up
 * address shows sign-in, and dozo-shell.css hides the link to sign-up through the attribute set
 * here. Sign-up waits for the answer so a closed deployment never flashes the form. With
 * registration open, or the answer lost, the page is upstream's as it is; upstream reports a
 * failed capabilities request itself.
 *
 * The page also offers the app's languages, since a visitor has no settings yet. A `lang` address
 * parameter (the landing page's links carry one) chooses the language before the page shows: only
 * an exact app language counts, anything else is dropped, and the parameter leaves the address
 * either way. The choice goes through `setUiLocale`, the same saved preference the settings use,
 * so it holds after sign-in, where the app saves it to the account.
 *
 * A server that signs in only with an account kept on the hosted server (`hostedLogin` in the same
 * capabilities) shows one way in instead, at the sign-in address; the other addresses lead there.
 * Such a server runs on the person's own computer (`ownComputer`). There a lost capabilities
 * answer shows that the server could not be reached, with a way to ask again, never a password
 * form its endpoints may no longer answer; and sign-in waits for the answer instead of flashing one.
 *
 * The landing page's links may also name a paid plan (`plan` and `period`). A valid one is kept
 * for an hour in this browser (`dozo-plan-intent`), anything else is ignored, and both parameters leave the address
 * the same way. The tab's title names the page, so it reads as sign-in or sign-up, not only the app.
 *
 * Where the server signs in with an emailed code, sign-in starts with the address alone and then
 * the code (dozo-code-sign-in.tsx, at `/sign-in`); upstream's password form stays one step away at
 * `/sign-in/email`. Sign-up is the same two steps with a name and no password
 * (dozo-code-sign-in.tsx, at `/sign-up`), since a verification link opened in another browser
 * cannot finish a password account. A server without codes keeps upstream's page at every address.
 */
/** A server on the person's own computer: the desktop app and the server bundle serve it here. */
const ownComputer = () => ["127.0.0.1", "[::1]"].includes(window.location.hostname);

function withoutLinkParams(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of ["lang", "plan", "period"]) next.delete(key);
  return next;
}

export function AuthPage(props: ComponentProps<typeof UpstreamAuthPage>) {
  const { t } = useLingui();
  const { search, pathname } = useLocation();
  const [params, setParams] = useSearchParams();
  const asked = params.get("lang");
  const wanted = UI_LOCALES.find((code) => code === asked);
  const [locale, setLocale] = useState<UiLocale>(getActiveUiLocale);
  const plan = params.get("plan");
  const period = params.get("period");
  useEffect(() => {
    if (plan === null && period === null) return;
    const intent = planIntentFromParams(plan, period);
    if (intent) savePlanIntent(intent);
    // A language in the address is dropped later, and these leave with it in one change.
    if (asked === null) setParams(withoutLinkParams, { replace: true });
  }, [plan, period, asked, setParams]);
  useEffect(() => {
    if (asked === null) return;
    let active = true;
    const drop = () => {
      if (!active) return;
      setParams(withoutLinkParams, { replace: true });
    };
    if (!wanted) {
      drop();
      return;
    }
    void setUiLocale(wanted)
      .then((activated) => {
        if (active) setLocale(activated);
      })
      .finally(drop);
    return () => {
      active = false;
    };
  }, [asked, wanted, setParams]);
  const title = props.mode === "up" ? t`Sign up` : props.mode === "in" ? t`Sign in` : null;
  useEffect(() => {
    if (!title) return;
    const before = document.title;
    // A tab title is one string, so it takes the usual title separator, not a muted element.
    document.title = `${title} – ${before}`;
    return () => {
      document.title = before;
    };
  }, [title]);
  const [signups, setSignups] = useState<"pending" | "open" | "closed">("pending");
  const [hosted, setHosted] = useState(false);
  const [capabilities, setCapabilities] = useState<AuthCapabilities | null>(null);
  const [capabilitiesFailed, setCapabilitiesFailed] = useState(false);
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void attempt;
    fetchAuthCapabilities().then(
      (capabilities) => {
        if (!active) return;
        setUnreachable(false);
        setCapabilities(capabilities);
        setHosted(capabilities.hostedLogin === true);
        setSignups(capabilities.signupsOpen === false ? "closed" : "open");
      },
      () => {
        if (!active) return;
        setCapabilitiesFailed(true);
        if (ownComputer()) setUnreachable(true);
        else setSignups("open");
      },
    );
    return () => {
      active = false;
    };
  }, [attempt]);
  const signingUp = props.mode === "up" && signups === "open";
  useEffect(() => {
    if (signingUp) markSignupStarted();
  }, [signingUp]);
  if (hosted && props.mode !== "in") return <Navigate to={`/sign-in${search}`} replace />;
  if (unreachable)
    return (
      <AuthFrame
        title={<Trans>Could not reach the server</Trans>}
        onSubmit={(event) => {
          event.preventDefault();
          setUnreachable(false);
          setAttempt((count) => count + 1);
        }}
      >
        <Button type="submit" size="lg" className={submitClass}>
          <Trans>Try again</Trans>
        </Button>
      </AuthFrame>
    );
  if (signups === "pending" && ownComputer()) return null;
  if (props.mode === "up" && signups !== "open") {
    return signups === "closed" ? <Navigate to={`/sign-in${search}`} replace /> : null;
  }
  // A language asked for in the address is shown from the first paint, never after a flash.
  if (wanted && wanted !== locale) return null;
  const codeFirst =
    (props.mode === "in" && pathname === "/sign-in") ||
    (props.mode === "up" && pathname === "/sign-up");
  // Sign-in and sign-up wait for the server's answer, so neither form flashes before the other.
  if (codeFirst && !capabilities && !capabilitiesFailed)
    return <div className="h-full bg-background" />;
  return (
    <div className="contents" data-dozo-signups={signups}>
      {hosted ? (
        <HostedSignIn />
      ) : codeFirst && dozoCodeSignInAvailable(capabilities) && capabilities ? (
        <DozoCodeSignIn
          mode={props.mode === "up" ? "up" : "in"}
          providers={signInProviders(capabilities)}
        />
      ) : (
        <UpstreamAuthPage {...props} />
      )}
      <div className="fixed bottom-4 left-1/2 -translate-x-1/2">
        <OptionSelect
          size="sm"
          className="w-auto"
          data-testid="auth-locale-select"
          aria-label={t`Language`}
          options={UI_LOCALES.map((code) => ({ value: code, label: APP_LOCALE_LABELS[code] }))}
          value={locale}
          onValueChange={(next) => {
            setLocale(next);
            void setUiLocale(next).then(setLocale);
          }}
        />
      </div>
    </div>
  );
}
