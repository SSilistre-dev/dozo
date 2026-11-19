import { useLingui } from "@lingui/react/macro";
import { Popover, PopoverContent, PopoverTrigger } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query";

/**
 * How much of this period's model input came back from the cache, as one number; pressing it
 * shows the two counts. Nothing without input this period, or while it loads.
 */
export function DozoCacheSavings() {
  const { t, i18n } = useLingui();
  const { data } = useQuery(useSpaceQueries().dozoUsage.cacheSavings.queryOptions());
  if (!data) return null;
  const count = new Intl.NumberFormat(i18n.locale);
  const percent = new Intl.NumberFormat(i18n.locale, { style: "percent" });
  const label = t`Cached input`;
  const details = [
    {
      label: t`Read from cache`,
      value: data.cacheReadTokens,
    },
    {
      label: t`Total input`,
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
