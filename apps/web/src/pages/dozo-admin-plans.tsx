import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { DozoAdminPlanQuotaChange, DozoAdminPlanRow } from "@rakazo/contracts";
import { Button, Input, Spinner } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { FormEvent, ReactNode } from "react";
import { useState } from "react";
import { formatBillingAmount } from "../lib/billing";
import { errorText, toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";

/**
 * The admin page's plans section, at `/admin/plans`: each plan's prices and machine as the server
 * has them, its members, and the two quotas an admin may change without a deploy. Prices are read
 * only. The admin page around it checks who may see it.
 */
export function DozoAdminPlans() {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  // Read once, and again whenever the window comes back: nothing here is polled.
  const plans = useQuery({
    ...queries.dozoAdmin.plans.list.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const change = useSave({
    save: (input: DozoAdminPlanQuotaChange, rpc) => rpc.dozoAdmin.plans.setQuota(input),
    stale: [queries.dozoAdmin.plans.list.key()],
    onFailed: (error) => toastError(t`Could not save the plan`, error),
  });

  if (plans.isPending)
    return (
      <div className="grid place-items-center py-10">
        <Spinner className="size-5 text-muted-foreground" aria-label={t`Loading…`} />
      </div>
    );
  if (plans.isError)
    return (
      <div role="alert" className="flex items-center gap-3 text-body text-destructive">
        {errorText(plans.error, t`Couldn't load the plans`)}
        <Button variant="outline" size="sm" onClick={() => void plans.refetch()}>
          <Trans>Retry</Trans>
        </Button>
      </div>
    );
  return (
    <div className="space-y-6">
      {plans.data.plans.map((plan) => (
        // Keyed by what is saved, so a save or another admin's change resets the fields.
        <Plan
          key={[plan.tier, plan.sharedSpaceMb.value, plan.computerHours.value].join(":")}
          plan={plan}
          pending={change.pending}
          onSave={(input) => change.run(input)}
        />
      ))}
    </div>
  );
}

/** Megabytes as the landing page writes them: whole gigabytes from 1024 MB up. */
function size(mb: number | null): ReactNode {
  if (mb === null) return <Trans>No limit</Trans>;
  if (mb < 1024) return <Trans>{mb} MB</Trans>;
  const gb = Math.round((mb / 1024) * 10) / 10;
  return <Trans>{gb} GB</Trans>;
}

function Row({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-10 items-center justify-between gap-4 text-body-sm">
      <span className="text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-2">{children}</div>
    </div>
  );
}

/** One line when a quota no longer says what the landing page says. */
function Landing({ quota, unit }: { quota: DozoAdminPlanRow["sharedSpaceMb"]; unit: ReactNode }) {
  if (!quota.set || quota.value === quota.terms) return null;
  return (
    <p className="text-right text-body-sm text-warning">
      <Trans>Landing says {unit}</Trans>
    </p>
  );
}

function Plan({
  plan,
  pending,
  onSave,
}: {
  plan: DozoAdminPlanRow;
  pending: boolean;
  onSave: (input: DozoAdminPlanQuotaChange) => void;
}) {
  const { t, i18n } = useLingui();
  const [space, setSpace] = useState(
    plan.sharedSpaceMb.set ? String(plan.sharedSpaceMb.value) : "",
  );
  const [hours, setHours] = useState(
    plan.computerHours.set ? String(plan.computerHours.value) : "",
  );
  // Empty follows the plan's terms.
  const quota = (text: string) => (text.trim() === "" ? null : Number(text));
  const stored = (value: DozoAdminPlanRow["sharedSpaceMb"]) => (value.set ? value.value : null);
  // Only what this admin edited, so a save never puts back what another admin changed meanwhile.
  const input: DozoAdminPlanQuotaChange = {
    tier: plan.tier,
    ...(quota(space) !== stored(plan.sharedSpaceMb) ? { sharedSpaceMb: quota(space) } : {}),
    ...(plan.computerHoursEditable && quota(hours) !== stored(plan.computerHours)
      ? { computerHours: quota(hours) }
      : {}),
  };
  const dirty = Object.keys(input).length > 1;
  const money = (cents: number) => formatBillingAmount(cents, plan.currency, i18n.locale);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave(input);
  };
  const keys = [plan.priceKeys.month, plan.priceKeys.year].filter(Boolean);
  return (
    <form
      onSubmit={submit}
      aria-label={plan.name}
      data-testid={`plan-${plan.tier}`}
      className="space-y-1 rounded-xl border border-border px-4 py-3"
    >
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="font-medium text-body">{plan.name}</h2>
        <span className="text-body-sm text-muted-foreground">
          <Plural value={plan.members} one="# member" other="# members" />
        </span>
      </div>
      <Row label={<Trans>Price</Trans>}>
        {plan.monthlyPriceCents === null ? (
          <Trans>Free</Trans>
        ) : (
          <span className="tabular-nums">
            <Trans>{money(plan.monthlyPriceCents)} / month</Trans>
            {plan.annualPriceCents === null ? null : (
              <>
                {" · "}
                <Trans>{money(plan.annualPriceCents)} / year</Trans>
              </>
            )}
          </span>
        )}
      </Row>
      {keys.length ? (
        <Row label={<Trans>Price keys</Trans>}>
          <span className="truncate font-mono text-body-sm text-muted-foreground">
            {keys.join(" · ")}
          </span>
        </Row>
      ) : null}
      {plan.computer ? (
        <Row label={<Trans>Computer</Trans>}>
          <Trans>
            {plan.computer.vcpus} vCPU · {plan.computer.memoryGb} GB RAM
          </Trans>
        </Row>
      ) : null}
      <Row label={<Trans>Shared space (MB)</Trans>}>
        <Input
          type="number"
          min={0}
          step={1}
          inputMode="numeric"
          className="w-28"
          aria-label={t`Shared space in MB for ${plan.name}`}
          placeholder={
            plan.sharedSpaceMb.terms === null ? t`No limit` : String(plan.sharedSpaceMb.terms)
          }
          value={space}
          disabled={pending}
          onChange={(event) => setSpace(event.target.value)}
        />
      </Row>
      <Landing quota={plan.sharedSpaceMb} unit={size(plan.sharedSpaceMb.terms)} />
      {plan.computerHoursEditable ? (
        <>
          <Row label={<Trans>Computer hours a month</Trans>}>
            <Input
              type="number"
              min={1}
              step={1}
              inputMode="numeric"
              className="w-28"
              aria-label={t`Computer hours a month for ${plan.name}`}
              placeholder={String(plan.computerHours.terms)}
              value={hours}
              disabled={pending}
              onChange={(event) => setHours(event.target.value)}
            />
          </Row>
          <Landing
            quota={plan.computerHours}
            unit={<Trans>{plan.computerHours.terms} hours</Trans>}
          />
        </>
      ) : null}
      {dirty ? (
        <div className="flex justify-end pt-2">
          <Button type="submit" size="sm" disabled={pending}>
            <Trans>Save</Trans>
          </Button>
        </div>
      ) : null}
    </form>
  );
}
