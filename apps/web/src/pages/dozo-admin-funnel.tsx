import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoFunnelDays, DozoFunnelStep } from "@rakazo/contracts";
import { DOZO_FUNNEL_DAYS } from "@rakazo/contracts";
import { Button, Spinner, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { errorText } from "../lib/dozo-error-text";
import { useSpaceQueries } from "../lib/query";

/** A median wait, short: minutes under two hours, hours under two days, then days. */
function useWait() {
  const { t } = useLingui();
  return (seconds: number) => {
    const minutes = Math.round(seconds / 60);
    if (minutes < 120) return t`${minutes} min`;
    const hours = Math.round(minutes / 60);
    if (hours < 48) return t`${hours} h`;
    const days = Math.round(hours / 24);
    return t`${days} d`;
  };
}

/** The admin page's funnel section, at `/admin/funnel`; the admin page checks who may see it. */
export function DozoAdminFunnel() {
  const { t } = useLingui();
  const wait = useWait();
  const [days, setDays] = useState<DozoFunnelDays>(30);
  const funnel = useQuery({
    ...useSpaceQueries().dozoAdmin.funnel.read.queryOptions({ input: { days } }),
    placeholderData: (previous) => previous,
    refetchOnWindowFocus: "always",
  });
  const names: Record<DozoFunnelStep, string> = {
    signedUp: t`Signed up`,
    modelConnected: t`Connected a model`,
    firstBot: t`Created a bot`,
    firstMessage: t`Sent a message`,
    paid: t`Paid`,
  };
  return (
    <section className="space-y-3">
      <ToggleGroup
        aria-label={t`Period`}
        value={[String(days)]}
        onValueChange={([next]) => {
          if (next) setDays(Number(next) as DozoFunnelDays);
        }}
        spacing={1}
        className="w-fit rounded-lg bg-muted p-1"
      >
        {DOZO_FUNNEL_DAYS.map((value) => (
          <ToggleGroupItem
            key={value}
            value={String(value)}
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>{value} days</Trans>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {funnel.isPending ? (
        <div className="grid place-items-center py-10">
          <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
        </div>
      ) : funnel.isError ? (
        <div role="alert" className="flex items-center gap-3 text-body text-destructive">
          {errorText(funnel.error, t`Couldn't load the funnel`)}
          <Button variant="outline" size="sm" onClick={() => void funnel.refetch()}>
            <Trans>Retry</Trans>
          </Button>
        </div>
      ) : funnel.data.steps[0]!.members === 0 ? (
        <p data-testid="funnel-empty" className="text-body-sm text-muted-foreground">
          <Trans>No sign-ups in this period</Trans>
        </p>
      ) : (
        <>
          <ul
            data-testid="funnel"
            className="divide-y divide-border rounded-xl border border-border"
          >
            {funnel.data.steps.map((row) => (
              <li
                key={row.step}
                aria-label={names[row.step]}
                className="grid grid-cols-[10rem_1fr_auto] items-center gap-3 px-4 py-3 text-body-sm"
              >
                <span className="truncate">{names[row.step]}</span>
                <span className="h-2 overflow-hidden rounded-full bg-muted">
                  <span
                    data-testid="funnel-bar"
                    className="block h-full rounded-full bg-primary"
                    style={{ width: `${(row.members * 100) / funnel.data.steps[0]!.members}%` }}
                  />
                </span>
                <span className="flex gap-x-3 tabular-nums">
                  <span>{row.members}</span>
                  <span className="w-10 text-right text-muted-foreground">
                    {row.rate === null ? "" : `${row.rate}%`}
                  </span>
                  <span className="w-14 text-right text-muted-foreground">
                    {row.medianSeconds === null ? "" : wait(row.medianSeconds)}
                  </span>
                </span>
              </li>
            ))}
          </ul>
          {funnel.data.granted ? (
            <p data-testid="funnel-granted" className="text-body-sm text-muted-foreground">
              <Trans>{funnel.data.granted} on a granted plan, not counted as paid</Trans>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
