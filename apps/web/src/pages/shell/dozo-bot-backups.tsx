import { Trans, useLingui } from "@lingui/react/macro";
import type { ModelRoleChoice } from "@rakazo/contracts";
import { connectedBackupOptions, MAX_MODEL_BACKUPS, modelRoleChoiceKey } from "@rakazo/contracts";
import { catalogEntryFor } from "@rakazo/core";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { MoreHorizontal, Plus } from "lucide-react";
import { toastError } from "../../lib/dozo-error-text";
import { useQueryUserId, useSave, useSpaceQueries } from "../../lib/query";
import { useSpaceRpc } from "../../lib/space-rpc";
import type { RoleModelOption } from "../model-settings/role-model-picker";
import { RoleModelPicker } from "../model-settings/role-model-picker";
import { DOZO_BOT_BACKUPS_KEY } from "./dozo-bot-backups-signal";

const choiceOf = (option: RoleModelOption): ModelRoleChoice => ({
  provider: option.provider,
  modelId: option.id,
  ...(option.credentialId ? { credentialId: option.credentialId } : {}),
});

const same = (left: ModelRoleChoice, right: ModelRoleChoice) =>
  modelRoleChoiceKey(left) === modelRoleChoiceKey(right);

/**
 * A bot's own backup models, in order, under its model in the bot panel: one "Add fallback" line
 * until there is one. They take over from the bot's model in their order; with none, the bot's
 * runs take the runner's own backups. Picked from the models of the viewer's own connections, as
 * in Models settings. Read again on the roster signal a change sends.
 */
export function DozoBotBackups({ botId, spaceId }: { botId: string; spaceId: string }) {
  const { t } = useLingui();
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  const userId = useQueryUserId();
  const key = [DOZO_BOT_BACKUPS_KEY, userId, spaceId, botId];
  const saved = useQuery({
    queryKey: key,
    queryFn: () => rpc.dozoBotModelBackups.get({ botId }),
  }).data?.backups;
  const credentials = useQuery(queries.models.credentials.queryOptions()).data ?? [];
  const catalog =
    useQuery({
      ...queries.models.forRole.queryOptions({
        input: { role: "main", expectedUserId: userId ?? "" },
      }),
      enabled: Boolean(userId),
    }).data ?? [];
  const save = useSave({
    save: (backups: ModelRoleChoice[], client) =>
      client.dozoBotModelBackups.set({ botId, backups }),
    stale: [key],
    onFailed: (error) => toastError(t`Could not save`, error),
  });
  if (!saved) return null;
  // While a save is on its way the list shows what it sends.
  const rows = save.pending && save.input ? save.input : saved;
  const options: RoleModelOption[] = connectedBackupOptions(catalog, credentials).map((choice) => ({
    ...(catalogEntryFor(catalog, choice.provider, choice.modelId) ?? {
      provider: choice.provider,
      id: choice.modelId,
      label: choice.label,
      billing: "",
    }),
    providerName: choice.connectionName,
    ...(choice.credentialId ? { credentialId: choice.credentialId } : {}),
  }));
  const optionFor = (choice: ModelRoleChoice) =>
    options.find((option) => same(choiceOf(option), choice));
  const label = (choice: ModelRoleChoice) =>
    optionFor(choice)?.label ??
    catalogEntryFor(catalog, choice.provider, choice.modelId)?.label ??
    choice.modelId;
  const commit = (next: ModelRoleChoice[]) => save.run(next);
  const move = (index: number, target: number) => {
    const next = [...rows];
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item!);
    commit(next);
  };
  const unused = options.filter((option) => rows.every((row) => !same(row, choiceOf(option))));
  return (
    <ol className="-mt-1" data-testid="dozo-bot-backups">
      {rows.map((choice, index) => {
        const name = label(choice);
        return (
          <li key={modelRoleChoiceKey(choice)} className="flex min-h-10 items-center gap-2">
            <RoleModelPicker
              trigger={
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-baseline gap-2 rounded-md py-1 text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  {/* The connection's name gives way first, so the model's stays readable. */}
                  <span className="max-w-full shrink-0 truncate text-body text-foreground">
                    {name}
                  </span>
                  <span className="min-w-0 truncate text-body-sm text-muted-foreground">
                    {optionFor(choice)?.providerName}
                  </span>
                </button>
              }
              label={t`Change ${name}`}
              options={unused}
              providers={[]}
              disabled={save.pending}
              onPick={(option) =>
                option
                  ? commit(rows.map((row, at) => (at === index ? choiceOf(option) : row)))
                  : null
              }
              onConnect={() => undefined}
            />
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0 text-muted-foreground"
                    aria-label={t`${name} options`}
                    disabled={save.pending}
                  />
                }
              >
                <MoreHorizontal />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="min-w-[200px]">
                {rows.length > 1 ? (
                  <>
                    <DropdownMenuItem disabled={index === 0} onClick={() => move(index, index - 1)}>
                      <Trans>Move up</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      disabled={index === rows.length - 1}
                      onClick={() => move(index, index + 1)}
                    >
                      <Trans>Move down</Trans>
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  variant="destructive"
                  onClick={() => commit(rows.filter((_, at) => at !== index))}
                >
                  <Trans>Remove</Trans>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </li>
        );
      })}
      {rows.length < MAX_MODEL_BACKUPS && unused.length ? (
        <li>
          <RoleModelPicker
            trigger={
              <button
                type="button"
                className="flex items-center gap-2 rounded-md py-2 text-start text-body text-muted-foreground outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <Plus className="size-4" aria-hidden />
                <Trans>Add fallback</Trans>
              </button>
            }
            label={t`Add fallback`}
            options={unused}
            providers={[]}
            disabled={save.pending}
            onPick={(option) => (option ? commit([...rows, choiceOf(option)]) : null)}
            onConnect={() => undefined}
          />
        </li>
      ) : null}
    </ol>
  );
}
