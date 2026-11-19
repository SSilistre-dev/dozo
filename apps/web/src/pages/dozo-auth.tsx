import { useLingui } from "@lingui/react/macro";
import { APP_LOCALE_LABELS } from "@rakazo/core";
import { OptionSelect } from "@rakazo/ui-web";
import type { ComponentProps } from "react";
import { useEffect, useState } from "react";
import { Navigate, useLocation, useSearchParams } from "react-router-dom";
import { fetchAuthCapabilities } from "../lib/auth-capabilities";
import { planIntentFromParams, savePlanIntent } from "../lib/dozo-plan-intent";
import { markSignupStarted } from "../lib/dozo-signup-start";
import { getActiveUiLocale, setUiLocale } from "../lib/i18n";
import type { UiLocale } from "../lib/ui-locale";
import { UI_LOCALES } from "../lib/ui-locale";
import { AuthPage as UpstreamAuthPage } from "./Auth";

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
 * The landing page's links may also name a paid plan (`plan` and `period`). A valid one is kept
 * for this tab (`dozo-plan-intent`), anything else is ignored, and both parameters leave the address
 * the same way. An `email` parameter (the verification result page's link) has filled upstream's
 * field by then and leaves with them. The tab's title names the page, so it reads as sign-in or
 * sign-up, not only the app.
 */
function withoutLinkParams(current: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(current);
  for (const key of ["lang", "plan", "period", "email"]) next.delete(key);
  return next;
}

export function AuthPage(props: ComponentProps<typeof UpstreamAuthPage>) {
  const { t } = useLingui();
  const { search } = useLocation();
  const [params, setParams] = useSearchParams();
  const asked = params.get("lang");
  const wanted = UI_LOCALES.find((code) => code === asked);
  const [locale, setLocale] = useState<UiLocale>(getActiveUiLocale);
  const plan = params.get("plan");
  const period = params.get("period");
  const email = params.get("email");
  useEffect(() => {
    if (plan === null && period === null && email === null) return;
    const intent = planIntentFromParams(plan, period);
    if (intent) savePlanIntent(intent);
    // A language in the address is dropped later, and these leave with it in one change.
    if (asked === null) setParams(withoutLinkParams, { replace: true });
  }, [plan, period, email, asked, setParams]);
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
  const signingUp = props.mode === "up" && signups === "open";
  useEffect(() => {
    if (signingUp) markSignupStarted();
  }, [signingUp]);
  if (props.mode === "up" && signups !== "open") {
    return signups === "closed" ? <Navigate to={`/sign-in${search}`} replace /> : null;
  }
  // A language asked for in the address is shown from the first paint, never after a flash.
  if (wanted && wanted !== locale) return null;
  return (
    <div className="contents" data-dozo-signups={signups}>
      <UpstreamAuthPage {...props} />
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
