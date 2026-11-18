import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoAdminUser } from "@rakazo/contracts";
import { BYOK_TIERS } from "@rakazo/contracts";
import { Button, Input, NativeSelect, NativeSelectOption, toast } from "@rakazo/ui-web";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorText } from "../lib/user-error";

type Choice = "pro" | "max" | "none";

/** A member's plan in the admin list, and the way to give one by hand or take it back. */
export function DozoPlanAction({ user }: { user: Pick<DozoAdminUser, "id" | "email" | "plan"> }) {
  const { t, i18n } = useLingui();
  const queries = useSpaceQueries();
  const { grantedUntil } = user.plan;
  const [open, setOpen] = useState(false);
  const [choice, setChoice] = useState<Choice>("pro");
  const [until, setUntil] = useState("");
  // The grant ends at the end of a UTC day, so the day is read in UTC too.
  const ends = grantedUntil
    ? new Date(grantedUntil).toLocaleDateString(i18n.locale, {
        dateStyle: "medium",
        timeZone: "UTC",
      })
    : null;
  const save = useSave({
    save: (input: { tier: "pro" | "max" | null; endsAt?: string }, rpc) =>
      rpc.dozoAdmin.setPlan({ userId: user.id, ...input }),
    stale: [queries.dozoAdmin.users.key()],
    onSaved: () => setOpen(false),
    onFailed: (error) => toast.error(errorText(error, t`Could not change the plan`)),
  });
  const granting = choice !== "none";

  return (
    <>
      <span data-testid="admin-plan" className="flex gap-x-2 text-body-sm text-muted-foreground">
        <span>{BYOK_TIERS[user.plan.tier].name}</span>
        {ends ? <span>{t`Until ${ends}`}</span> : null}
      </span>
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
            save.run(granting ? { tier: choice, endsAt: `${until}T23:59:59.000Z` } : { tier: null })
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
