import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { DozoAdminPayment, DozoAdminRevenuePeriod } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import {
  Badge,
  Button,
  buttonVariants,
  SectionHeading,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeft } from "lucide-react";
import type { ReactNode } from "react";
import { Fragment, useState } from "react";
import { Link } from "react-router-dom";
import { PageLoading } from "../components/PageLoading";
import { useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";
import { NotFoundPage } from "./NotFound";
import { WindowChrome } from "./WindowChrome";

/** The admin billing page. Anyone else sees the page an unknown address shows. */
export function DozoAdminBillingPage() {
  const { t } = useLingui();
  const me = useQuery(useSpaceQueries().me.queryOptions());
  if (me.isPending) return <PageLoading />;
  if (!me.data?.isAdmin) return <NotFoundPage />;
  return (
    <div className="flex h-full min-w-0 flex-col overflow-hidden bg-background text-foreground">
      <WindowChrome />
      <header className="flex items-center gap-1 border-b px-4 py-3">
        <Link
          to="/admin"
          className={buttonVariants({ variant: "ghost", size: "icon" })}
          aria-label={t`Back`}
        >
          <ChevronLeft />
        </Link>
        <h1 className="flex-1 px-2 font-medium">
          <Trans>Billing</Trans>
        </h1>
      </header>
      <main className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-3xl space-y-8 px-4 py-6">
          <Summary />
          <Revenue />
        </div>
      </main>
    </div>
  );
}

function Loading() {
  const { t } = useLingui();
  return (
    <div className="grid place-items-center py-10">
      <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
    </div>
  );
}

function Failed({ error, retry }: { error: unknown; retry: () => void }) {
  const { t } = useLingui();
  return (
    <div role="alert" className="flex items-center gap-3 text-body text-destructive">
      {errorText(error, t`Couldn't load billing`)}
      <Button variant="outline" size="sm" onClick={retry}>
        <Trans>Retry</Trans>
      </Button>
    </div>
  );
}

function Rows({ testId, children }: { testId: string; children: ReactNode }) {
  return (
    <ul data-testid={testId} className="divide-y divide-border rounded-xl border border-border">
      {children}
    </ul>
  );
}

function Summary() {
  const summary = useQuery({
    ...useSpaceQueries().dozoAdmin.billing.summary.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  if (summary.isPending) return <Loading />;
  if (summary.isError) return <Failed error={summary.error} retry={() => void summary.refetch()} />;
  const data = summary.data;
  return (
    <section className="space-y-3">
      <p data-testid="billing-summary" className="flex flex-wrap gap-x-4 text-body-sm">
        <span>
          <Plural value={data.members} one="# member" other="# members" />
        </span>
        <span className="text-muted-foreground">
          <Trans>{data.paid} paid</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>{data.trialing} on trial</Trans>
        </span>
        <span className="text-muted-foreground">
          <Trans>{data.granted} granted</Trans>
        </span>
      </p>
      <Rows testId="billing-plans">
        {data.plans.map((plan) => (
          <li
            key={plan.tier}
            className="flex items-center gap-3 px-4 py-3 text-body-sm"
            aria-label={BYOK_TIERS[plan.tier].name}
          >
            <span className="flex-1 font-medium text-body">{BYOK_TIERS[plan.tier].name}</span>
            <span className="flex flex-wrap gap-x-3 text-muted-foreground">
              {plan.monthly ? (
                <span>
                  <Trans>{plan.monthly} monthly</Trans>
                </span>
              ) : null}
              {plan.yearly ? (
                <span>
                  <Trans>{plan.yearly} yearly</Trans>
                </span>
              ) : null}
              {plan.granted ? (
                <span>
                  <Trans>{plan.granted} granted</Trans>
                </span>
              ) : null}
            </span>
            <span className="tabular-nums">{plan.total}</span>
          </li>
        ))}
      </Rows>
      <p
        data-testid="billing-ending"
        className="flex flex-wrap gap-x-4 text-body-sm text-muted-foreground"
      >
        <span>
          <Trans>{data.ending.within7Days} ending in 7 days</Trans>
        </span>
        <span>
          <Trans>{data.ending.within30Days} in 30 days</Trans>
        </span>
        {data.pastDue ? (
          <span className="text-destructive">
            <Trans>{data.pastDue} past due</Trans>
          </span>
        ) : null}
        {data.cancelling ? (
          <span>
            <Trans>{data.cancelling} cancelling</Trans>
          </span>
        ) : null}
      </p>
    </section>
  );
}

/** The amount in the currency's minor unit, shown in that currency. */
function useMoney() {
  const { i18n } = useLingui();
  return (amount: number, currency: string) => {
    const code = currency.toUpperCase();
    try {
      const format = new Intl.NumberFormat(i18n.locale, { style: "currency", currency: code });
      return format.format(amount / 10 ** (format.resolvedOptions().maximumFractionDigits ?? 2));
    } catch {
      return `${amount} ${code}`;
    }
  };
}

function Revenue() {
  const { t, i18n } = useLingui();
  const money = useMoney();
  const [period, setPeriod] = useState<DozoAdminRevenuePeriod>("thisMonth");
  const revenue = useQuery({
    ...useSpaceQueries().dozoAdmin.billing.revenue.queryOptions({ input: { period } }),
    placeholderData: (previous) => previous,
  });
  // Without a payment provider there is nothing to show.
  if (revenue.data === null) return null;
  const status: Record<DozoAdminPayment["status"], ReactNode> = {
    paid: <Trans>Paid</Trans>,
    refunded: <Trans>Refunded</Trans>,
    failed: <Trans>Failed</Trans>,
  };
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center gap-3">
        <SectionHeading className="flex-1">
          <Trans>Payments</Trans>
        </SectionHeading>
        <ToggleGroup
          aria-label={t`Period`}
          value={[period]}
          onValueChange={([next]) => {
            if (next) setPeriod(next as DozoAdminRevenuePeriod);
          }}
          spacing={1}
          className="rounded-lg bg-muted p-1"
        >
          <ToggleGroupItem
            value="thisMonth"
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>This month</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="lastMonth"
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>Last month</Trans>
          </ToggleGroupItem>
          <ToggleGroupItem
            value="last12Months"
            className="text-body-sm aria-pressed:bg-background aria-pressed:shadow-sm"
          >
            <Trans>12 months</Trans>
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
      {revenue.isPending ? (
        <Loading />
      ) : revenue.isError ? (
        <Failed error={revenue.error} retry={() => void revenue.refetch()} />
      ) : (
        <>
          <p data-testid="billing-totals" className="flex flex-wrap gap-x-4 text-body-sm">
            {revenue.data.totals.length === 0 ? (
              <span className="text-muted-foreground">
                <Trans>No payments</Trans>
              </span>
            ) : null}
            {revenue.data.totals.map((total) => {
              const paid = money(total.paid, total.currency);
              const refunded = money(total.refunded, total.currency);
              return (
                <Fragment key={total.currency}>
                  <span>
                    <Trans>{paid} paid</Trans>
                  </span>
                  {total.refunded ? (
                    <span className="text-muted-foreground">
                      <Trans>{refunded} refunded</Trans>
                    </span>
                  ) : null}
                </Fragment>
              );
            })}
            {revenue.data.failed ? (
              <span className="text-destructive">
                <Plural
                  value={revenue.data.failed}
                  one="# failed payment"
                  other="# failed payments"
                />
              </span>
            ) : null}
            {revenue.data.partial ? (
              <span className="text-muted-foreground">
                <Trans>Newest records only</Trans>
              </span>
            ) : null}
          </p>
          {revenue.data.payments.length > 0 ? (
            <Rows testId="billing-payments">
              {revenue.data.payments.map((payment, index) => (
                <li key={index} className="flex items-center gap-3 px-4 py-3 text-body-sm">
                  <span className="min-w-0 flex-1 truncate">
                    {payment.member ? (
                      <Link to={`/admin/users/${payment.member.id}`} className="hover:underline">
                        {payment.member.email}
                      </Link>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {new Date(payment.at).toLocaleDateString(i18n.locale, { dateStyle: "medium" })}
                  </span>
                  <span className="tabular-nums">{money(payment.amount, payment.currency)}</span>
                  <Badge variant={payment.status === "failed" ? "destructive" : "outline"}>
                    {status[payment.status]}
                  </Badge>
                </li>
              ))}
            </Rows>
          ) : null}
        </>
      )}
    </section>
  );
}
