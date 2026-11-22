import { Trans } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { errorText, toastError } from "../lib/dozo-error-text";
import { queryClient, useSave, useSpaceQueries } from "../lib/query";

/**
 * Puts one of the owner's own skills in their organization's library, so every member of its
 * Spaces reads it. Shown only to the organization's owner, once it has someone to share with.
 */
export function DozoOrganizationLibrarySwitch({ skillId }: { skillId: string }) {
  const id = useId();
  const queries = useSpaceQueries();
  const library = useQuery(queries.dozoOrganizationLibrary.get.queryOptions()).data;
  const save = useSave({
    save: (shared: boolean, rpc) => rpc.dozoOrganizationLibrary.share({ skillId, shared }),
    stale: [queries.dozoOrganizationLibrary.key(), queries.agentSkills.key()],
    onFailed: (error) => toastError(errorText(error)),
  });
  if (!library?.canShare) return null;
  const shared = save.pending ? Boolean(save.input) : library.skillIds.includes(skillId);
  return (
    <div className="flex items-center gap-2">
      <Label htmlFor={id} className="text-body-sm font-normal text-muted-foreground">
        <Trans>Organization</Trans>
      </Label>
      <Switch
        id={id}
        data-testid="organization-library-switch"
        checked={shared}
        disabled={save.pending}
        onCheckedChange={(checked) => save.run(checked)}
      />
    </div>
  );
}

/** A library change comes on the roster signal: read the skills and the library again. */
export function dozoOrganizationLibraryChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) &&
      (path.at(-2) === "dozoOrganizationLibrary" || path.at(-2) === "agentSkills"),
  });
}
