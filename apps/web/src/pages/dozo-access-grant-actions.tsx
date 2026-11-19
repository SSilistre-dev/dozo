import { Trans, useLingui } from "@lingui/react/macro";
import type { AccessGrant, AccessGrantInput } from "@rakazo/contracts";
import {
  Button,
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Field,
  FieldLabel,
  Input,
} from "@rakazo/ui-web";
import { Ellipsis } from "lucide-react";
import type { FormEvent } from "react";
import { useState } from "react";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";

type Change = { update: { id: string; grant: AccessGrantInput } } | { delete: string };

/**
 * A free-access grant's actions on the admin access page, in place of upstream's lone Revoke: a
 * pending grant can be edited, revoked or deleted, a revoked one deleted. A received grant has
 * none: what it gave is the account's.
 */
export function DozoGrantActions({
  grant,
  busy,
  onRevoke,
}: {
  grant: AccessGrant;
  busy: boolean;
  onRevoke: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const change = useSave({
    save: (input: Change, rpc) =>
      "update" in input
        ? rpc.dozoAdmin.accessGrants.update(input.update)
        : rpc.dozoAdmin.accessGrants.delete({ id: input.delete }),
    stale: [queries.accessGrants.list.key()],
    onSaved: () => setEditing(false),
    onFailed: (error, input) =>
      toastError(
        "update" in input ? t`Could not save the grant` : t`Could not delete grant`,
        error,
      ),
  });
  if (grant.status === "applied") return null;
  const disabled = busy || change.pending;
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          render={
            <Button variant="ghost" size="icon-sm" aria-label={t`Actions for ${grant.email}`} />
          }
        >
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {grant.status === "pending" ? (
            <>
              <DropdownMenuItem onClick={() => setEditing(true)}>
                <Trans>Edit</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem onClick={onRevoke}>
                <Trans>Revoke</Trans>
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}>
            <Trans>Delete</Trans>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {deleting ? (
        <ConfirmDialog
          title={<Trans>Delete the grant for {grant.email}?</Trans>}
          description={<Trans>This cannot be undone.</Trans>}
          confirmLabel={<Trans>Delete</Trans>}
          onCancel={() => setDeleting(false)}
          onConfirm={() => {
            setDeleting(false);
            change.run({ delete: grant.id });
          }}
        />
      ) : null}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              <Trans>Edit grant</Trans>
            </DialogTitle>
          </DialogHeader>
          {editing ? (
            <GrantForm
              grant={grant}
              pending={change.pending}
              onSave={(input) => change.run({ update: { id: grant.id, grant: input } })}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function GrantForm({
  grant,
  pending,
  onSave,
}: {
  grant: AccessGrant;
  pending: boolean;
  onSave: (input: AccessGrantInput) => void;
}) {
  const [email, setEmail] = useState(grant.email);
  const [credits, setCredits] = useState(grant.creditCents ? String(grant.creditCents / 100) : "");
  const [months, setMonths] = useState(grant.freeMonths ? String(grant.freeMonths) : "");
  const creditCents = Math.round(Number(credits || 0) * 100);
  const freeMonths = Number(months || 0);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onSave({ email, creditCents, freeMonths });
  };
  return (
    <form onSubmit={submit} className="grid gap-3">
      <Field>
        <FieldLabel htmlFor="edit-grant-email">
          <Trans>Email</Trans>
        </FieldLabel>
        <Input
          id="edit-grant-email"
          type="email"
          value={email}
          maxLength={254}
          required
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-grant-credits">
          <Trans>Credits ($)</Trans>
        </FieldLabel>
        <Input
          id="edit-grant-credits"
          type="number"
          min={0}
          max={1000}
          step={1}
          value={credits}
          onChange={(event) => setCredits(event.target.value)}
        />
      </Field>
      <Field>
        <FieldLabel htmlFor="edit-grant-months">
          <Trans>Free months</Trans>
        </FieldLabel>
        <Input
          id="edit-grant-months"
          type="number"
          min={0}
          max={12}
          step={1}
          value={months}
          onChange={(event) => setMonths(event.target.value)}
        />
      </Field>
      <DialogFooter>
        <Button
          type="submit"
          disabled={pending || !email.trim() || (creditCents <= 0 && freeMonths <= 0)}
        >
          <Trans>Save</Trans>
        </Button>
      </DialogFooter>
    </form>
  );
}
