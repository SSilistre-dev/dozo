import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";

/**
 * Turkish for the strings below. The fork never edits the translation catalogs, so its own
 * strings carry fixed ids and their translations here, merged into the locale's catalog (a
 * catalog loaded later merges into the same object and keeps them). Compiled form: plain text is
 * a one-element array. Other languages show the English.
 */
const TRANSLATIONS: Record<string, Messages> = {
  tr: {
    "dozo.cacheSavings.label": ["Önbellekten girdi"],
    "dozo.cacheSavings.read": ["Önbellekten okunan"],
    "dozo.cacheSavings.input": ["Toplam girdi"],
  },
};
for (const [locale, messages] of Object.entries(TRANSLATIONS)) i18n.load(locale, messages);

/**
 * How much of this period's model input came back from the cache, as one number; pressing it
 * shows the two counts. Nothing without input this period, or while it loads.
 */
export function DozoCacheSavings() {
  const { t, i18n: active } = useLingui();
  const { data } = useQuery(useSpaceQueries().dozoUsage.cacheSavings.queryOptions());
  if (!data) return null;
  const count = new Intl.NumberFormat(active.locale);
  const percent = new Intl.NumberFormat(active.locale, { style: "percent" });
  const label = t({ id: "dozo.cacheSavings.label", message: "Cached input" });
  const details = [
    {
      label: t({ id: "dozo.cacheSavings.read", message: "Read from cache" }),
      value: data.cacheReadTokens,
    },
    {
      label: t({ id: "dozo.cacheSavings.input", message: "Total input" }),
      value: data.inputTokens,
    },
  ];
  return (
    <div data-testid="cache-savings" className="mb-3 rounded-xl border border-border">
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              className="flex w-full items-baseline justify-between gap-3 rounded-xl px-4 py-3 text-left outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring"
            />
          }
        >
          <span className="text-body font-medium text-foreground">{label}</span>
          <span className="text-body tabular-nums text-foreground">
            {percent.format(data.cacheReadPercent / 100)}
          </span>
        </PopoverTrigger>
        <PopoverContent align="end" sideOffset={6} className="w-64">
          <dl className="grid gap-1.5 text-body-sm">
            {details.map((row) => (
              <div key={row.label} className="flex items-baseline justify-between gap-3">
                <dt className="text-muted-foreground">{row.label}</dt>
                <dd className="tabular-nums text-foreground">{count.format(row.value)}</dd>
              </div>
            ))}
          </dl>
        </PopoverContent>
      </Popover>
    </div>
  );
}
