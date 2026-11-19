import { useLingui } from "@lingui/react/macro";
import { getActiveUiLocale } from "../lib/i18n";

const SITE = "https://dozo-site.ssilistre.dev";

/** The terms and privacy policy, one line under the sign-up button, in the page's language. */
export function DozoSignupTerms() {
  const { t } = useLingui();
  // Read on every render: a language picked on the page re-renders it through Lingui.
  const base = getActiveUiLocale() === "tr" ? `${SITE}/tr` : SITE;
  const link = "underline-offset-4 hover:text-foreground hover:underline";
  return (
    <p className="mt-3 text-center text-body-sm text-muted-foreground">
      <a href={`${base}/terms/`} target="_blank" rel="noopener noreferrer" className={link}>
        {t`Terms`}
      </a>
      {" · "}
      <a href={`${base}/privacy/`} target="_blank" rel="noopener noreferrer" className={link}>
        {t`Privacy`}
      </a>
    </p>
  );
}
