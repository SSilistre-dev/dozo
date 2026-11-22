import { Trans } from "@lingui/react/macro";
import { Label, Switch } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { errorText, toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";

type Change = { skillId: string; on: boolean; mode: "share" | "use" };

/** The library of the open Space's organization, and the one save that changes it. */
function useLibrary() {
  const queries = useSpaceQueries();
  const library = useQuery(queries.dozoOrganizationLibrary.get.queryOptions()).data;
  const save = useSave({
    save: ({ skillId, on, mode }: Change, rpc) =>
      mode === "share"
        ? rpc.dozoOrganizationLibrary.share({ skillId, shared: on })
        : rpc.dozoOrganizationLibrary.hide({ skillId, hidden: !on }),
    stale: [queries.dozoOrganizationLibrary.key(), queries.agentSkills.key()],
    onFailed: (error) => toastError(errorText(error)),
  });
  return { library, save };
}

function OrganizationSwitch({
  checked,
  pending,
  onChange,
}: {
  checked: boolean;
  pending: boolean;
  onChange: (on: boolean) => void;
}) {
  const id = useId();
  return (
    <div className="flex shrink-0 items-center gap-2">
      <Label htmlFor={id} className="text-body-sm font-normal text-muted-foreground">
        <Trans>Organization</Trans>
      </Label>
      <Switch
        id={id}
        data-testid="organization-library-switch"
        checked={checked}
        disabled={pending}
        onCheckedChange={onChange}
      />
    </div>
  );
}

/**
 * The Organization switch in a skill's editor. For the organization's owner, on one of their own
 * skills: it puts the skill in the library, shown once the organization has someone to share with.
 * For a member, on a library skill someone else owns (`readOnly`): it says where the skill comes
 * from, and off keeps it out of their own bots.
 */
export function DozoOrganizationLibrarySwitch({
  skillId,
  readOnly = false,
}: {
  skillId: string;
  readOnly?: boolean;
}) {
  const { library, save } = useLibrary();
  if (!library || (!readOnly && !library.canShare)) return null;
  const mode = readOnly ? "use" : "share";
  const stored = readOnly
    ? !library.hidden.some((skill) => skill.id === skillId)
    : library.skillIds.includes(skillId);
  const pending = save.pending && save.input?.skillId === skillId;
  return (
    <OrganizationSwitch
      checked={pending ? Boolean(save.input?.on) : stored}
      pending={save.pending}
      onChange={(on) => save.run({ skillId, on, mode })}
    />
  );
}

/** Marks a skill in the list as the organization library's, someone else's and read only. */
export function DozoLibraryBadge() {
  return (
    <span className="text-body-sm text-muted-foreground">
      <Trans>Organization</Trans>
    </span>
  );
}

/**
 * The library skills this member turned off, under their skills, each with the switch that turns
 * it back on. Nothing while there are none.
 */
export function DozoHiddenLibrarySkills() {
  const { library, save } = useLibrary();
  if (!library?.hidden.length) return null;
  return (
    <div data-testid="organization-library-hidden">
      {library.hidden.map((skill) => {
        const pending = save.pending && save.input?.skillId === skill.id;
        return (
          <div key={skill.id} className="flex items-center justify-between gap-3 py-2.5">
            <span className="min-w-0">
              <span className="block truncate text-body text-muted-foreground" dir="auto">
                {skill.name}
              </span>
              <span className="block truncate text-body-sm text-muted-foreground" dir="auto">
                {skill.description}
              </span>
            </span>
            <OrganizationSwitch
              checked={pending ? Boolean(save.input?.on) : false}
              pending={save.pending}
              onChange={(on) => save.run({ skillId: skill.id, on, mode: "use" })}
            />
          </div>
        );
      })}
    </div>
  );
}

export { dozoOrganizationLibraryChanged } from "./dozo-organization-library-changed";
