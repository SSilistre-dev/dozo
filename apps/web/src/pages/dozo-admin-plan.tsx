import { Plural, Trans, useLingui } from "@lingui/react/macro";
import type { DozoAdminPlan, DozoAdminUser } from "@rakazo/contracts";
import { BYOK_TIERS, grantEndsAt, planEndDays } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption } from "@rakazo/ui-web";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";

type Choice = "pro" | "max" | "none";

/**
 * A member's plan, what keeps it and how many days it has left, counted as the member's own page
 * counts them; the date itself on hover, and the plan that follows a granted one. Free with
 * nothing running out is the plan's name alone.
 */
export function DozoPlanSummary({ plan }: { plan: DozoAdminPlan }) {
  const { t, i18n } = useLingui();
  const { ends } = plan;
  const days = ends ? planEndDays(ends) : 0;
  const source = ends
    ? {
        subscription: t`Subscription`,
        trial: t`Trial`,
        granted: t`Granted`,
        freeMonth: t`Free period`,
      }[ends.source]
    : null;
  return (
    <span data-testid="admin-plan" className="flex gap-x-2 text-body-sm text-muted-foreground">
      <span>{BYOK_TIERS[plan.tier].name}</span>
      {ends ? (
        <>
          <span>{source}</span>
          <span
            title={new Date(ends.at).toLocaleDateString(i18n.locale, {
              dateStyle: "medium",
              timeZone: "UTC",
            })}
          >
            {ends.renews ? (
              <Plural value={days} one="Renews in # day" other="Renews in # days" />
            ) : (
              <Plural value={days} one="# day left" other="# days left" />
            )}
          </span>
          {ends.fallsTo ? <span>{t`Then ${ends.fallsTo.to}`}</span> : null}
        </>
      ) : null}
    </span>
  );
}

/** A member's plan in the admin list, and the way to give one by hand or take it back. */
export function DozoPlanAction({ user }: { user: Pick<DozoAdminUser, "id" | "email" | "plan"> }) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const { grantedUntil } = user.plan;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>("pro");
  const [until, setUntil] = useState("");
  const save = useSave({
    save: (input: { tier: "pro" | "max" | null; endsAt?: string }, rpc) =>
      rpc.dozoAdmin.setPlan({ userId: user.id, ...input }),
    stale: [queries.dozoAdmin.users.key(), queries.dozoAdmin.user.key()],
    onSaved: () => setOpen(false),
    onFailed: (error) => toastError(t`Could not change the plan`, error),
  });
  const granting = choice !== "none";
  // The first day that can be chosen is tomorrow, on the admin's calendar.
  const next = new Date();
  next.setDate(next.getDate() + 1);
  const tomorrow = [
    next.getFullYear(),
    String(next.getMonth() + 1).padStart(2, "0"),
    String(next.getDate()).padStart(2, "0"),
  ].join("-");

  return (
    <>
      <DozoPlanSummary plan={user.plan} />
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          // Start from what is granted now: its end date, and a plan to replace it with.
          setChoice(grantedUntil && user.plan.tier === "max" ? "max" : "pro");
          setUntil(grantedUntil?.slice(0, 10) ?? "");
          setOpen(true);
        }}
      >
        <Trans>Set plan</Trans>
      </Button>
      {open ? (
        <ConfirmDialog
          variant="default"
          title={<Trans>Plan for {user.email}</Trans>}
          confirmLabel={<Trans>Save</Trans>}
          busy={save.pending}
          confirmDisabled={granting && !until}
          onCancel={() => setOpen(false)}
          onConfirm={() =>
            save.run(granting ? { tier: choice, endsAt: grantEndsAt(until) } : { tier: null })
          }
        >
          <div className="flex flex-wrap items-center gap-2">
            <NativeSelect
              aria-label={t`Plan`}
              value={choice}
              onChange={(event) => setChoice(event.target.value as Choice)}
            >
              <NativeSelectOption value="pro">{BYOK_TIERS.pro.name}</NativeSelectOption>
              <NativeSelectOption value="max">{BYOK_TIERS.max.name}</NativeSelectOption>
              {grantedUntil ? (
                <NativeSelectOption value="none">{t`Remove granted plan`}</NativeSelectOption>
              ) : null}
            </NativeSelect>
            {granting ? (
              <Input
                type="date"
                min={tomorrow}
                aria-label={t`End date`}
                className="w-auto"
                value={until}
                onChange={(event) => setUntil(event.target.value)}
              />
            ) : null}
          </div>
        </ConfirmDialog>
      ) : null}
    </>
  );
}
