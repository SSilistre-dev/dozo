import { useLingui } from "@lingui/react/macro";
import { APP_LOCALE_LABELS } from "@rakazo/core";
import { OptionSelect } from "@rakazo/ui-web";
import { setUiLocale } from "../lib/locale/i18n";
import type { UiLocale } from "../lib/locale/ui-locale";
import { UI_LOCALES } from "../lib/locale/ui-locale";

/**
 * The language choice at the foot of every signed-out account screen: a visitor from a mailed link
 * has no settings yet. The choice goes through `setUiLocale`, the saved preference the settings use.
 */
export function AuthLocaleSelect({
  locale,
  onChange,
}: {
  locale: UiLocale;
  onChange: (locale: UiLocale) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="fixed bottom-4 left-1/2 -translate-x-1/2">
      <OptionSelect
        size="sm"
        className="w-auto"
        data-testid="auth-locale-select"
        aria-label={t`Language`}
        options={UI_LOCALES.map((code) => ({ value: code, label: APP_LOCALE_LABELS[code] }))}
        value={locale}
        onValueChange={(next) => {
          onChange(next);
          void setUiLocale(next).then(onChange);
        }}
      />
    </div>
  );
}
