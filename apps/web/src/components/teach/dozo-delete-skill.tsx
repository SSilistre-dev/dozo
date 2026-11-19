import { Trans, useLingui } from "@lingui/react/macro";
import { Button } from "@rakazo/ui-web";
import { Trash2Icon } from "lucide-react";
import { useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorText } from "../../lib/user-error";
import { ConfirmDialog } from "../ConfirmDialog";

/**
 * Deletes a draft or saved skill after a confirmation; its values and pictures go with it in the
 * same statement. Cards and lists showing the skill read it again, so they show it gone.
 * `icon` is the compact form for a list row.
 */
export function DeleteSkill({
  skillId,
  name,
  icon = false,
  onDeleted,
}: {
  skillId: string;
  name: string;
  icon?: boolean;
  onDeleted?: () => void;
}) {
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const [open, setOpen] = useState(false);
  const remove = useSave<void, { ok: true }>({
    save: (_input, rpc) => rpc.skills.remove({ skillId }),
    stale: [queries.skills.list.key(), queries.dozoTeach.review.key()],
    onSaved: () => {
      setOpen(false);
      onDeleted?.();
    },
  });
  return (
    <>
      {icon ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={t`Delete`}
          className="shrink-0"
          onClick={() => setOpen(true)}
        >
          <Trash2Icon className="size-3.5" />
        </Button>
      ) : (
        <Button variant="ghost" onClick={() => setOpen(true)}>
          <Trans>Delete</Trans>
        </Button>
      )}
      {open ? (
        <ConfirmDialog
          onCancel={() => {
            setOpen(false);
            remove.reset();
          }}
          title={<Trans>Delete "{name}"?</Trans>}
          description={<Trans>This can't be undone.</Trans>}
          error={remove.error ? errorText(remove.error) : null}
          busy={remove.pending}
          onConfirm={() => remove.run()}
          confirmLabel={remove.pending ? <Trans>Deleting…</Trans> : <Trans>Delete</Trans>}
        />
      ) : null}
    </>
  );
}
