import { Trans } from "@lingui/react/macro";
import type { DozoLearningMode } from "@rakazo/contracts";
import { DOZO_LEARNING_CHANGED_CODE } from "@rakazo/contracts";
import { Button, NativeSelect, NativeSelectOption, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { errorText, toastError } from "../lib/dozo-error-text";
import { useQueryUserId, useSave, useSpaceQueries } from "../lib/query/query";
import { errorCode } from "../../../../packages/i18n/src/user-error";
import { SettingsCard } from "./shell/bots/bot-settings-sections";

function changedSince(error: Error | null): boolean {
  return errorCode(error) === DOZO_LEARNING_CHANGED_CODE;
}

/**
 * Under the bot's memory, for its owner only (`ownerId`, unknown on an older server): how it learns
 * from their chat (off, suggesting skills to save, or also writing notes itself), offered only
 * while nobody else is in the Space, and the lines it learned, each to undo. Nothing when the
 * setting cannot be read (a server without it).
 */
export function DozoLearningSection({
  botId,
  ownerId,
}: {
  botId: string;
  ownerId?: string | null;
}) {
  const ids = useId();
  const me = useQueryUserId();
  const owner = Boolean(ownerId) && ownerId === me;
  const queries = useSpaceQueries();
  const learning = queries.dozoLearning.get.queryOptions({ input: { botId } });
  // Reviews write as the bot runs, so every open reads again, as the memory list does.
  const read = useQuery({ ...learning, enabled: owner, refetchOnMount: "always" });
  const mode = useSave({
    save: (next: DozoLearningMode, rpc) => rpc.dozoLearning.setMode({ botId, mode: next }),
    stale: [learning.queryKey],
    onFailed: (error) => toastError(errorText(error)),
  });
  const undo = useSave({
    save: (changeId: string, rpc) => rpc.dozoLearning.undo({ changeId }),
    // An undo rewrites MEMORY.md, which the memory list above and its budget show.
    stale: [
      learning.queryKey,
      queries.memory.list.queryKey({ input: { botId, scope: "bot" } }),
      queries.memory.budget.queryKey({ input: { botId } }),
    ],
    onFailed: (error) => {
      if (!changedSince(error)) toastError(errorText(error));
    },
  });
  if (!owner || !read.data) return null;
  const current = mode.pending && mode.input ? mode.input : read.data.mode;
  const changes = read.data.changes.filter((change) => !change.undoneAt);
  const conflictId = !undo.pending && changedSince(undo.error) ? undo.input : undefined;
  const { available } = read.data;
  if (!available && !changes.length) return null;
  return (
    <section data-testid="bot-learning">
      {available ? (
        <SettingsCard>
          <label
            htmlFor={`${ids}-learn`}
            className="flex min-h-12 items-center justify-between gap-3 text-body text-foreground"
          >
            <Trans>Learn from chats</Trans>
            <NativeSelect
              id={`${ids}-learn`}
              size="sm"
              className="w-auto"
              value={current}
              disabled={mode.pending}
              onChange={(event) => mode.run(event.target.value as DozoLearningMode)}
            >
              <NativeSelectOption value="off">
                <Trans>Off</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="ask">
                <Trans id="Ask first">Ask first</Trans>
              </NativeSelectOption>
              <NativeSelectOption value="auto">
                <Trans>Auto</Trans>
              </NativeSelectOption>
            </NativeSelect>
          </label>
        </SettingsCard>
      ) : null}
      {changes.length ? (
        <>
          <SectionHeading variant="label" className={available ? "mt-6 mb-2" : "mb-2"}>
            <Trans>Learned</Trans>
          </SectionHeading>
          <ul className="rounded-xl bg-muted/50 px-4 py-1">
            {changes.map((change) => {
              const lineId = `${ids}-line-${change.id}`;
              const buttonId = `${ids}-undo-${change.id}`;
              return (
                <li
                  key={change.id}
                  className="flex min-h-12 items-center gap-3 border-b border-border py-2 last:border-0"
                >
                  <span id={lineId} className="min-w-0 flex-1 text-body text-foreground" dir="auto">
                    {change.kind === "remove" ? (
                      <s className="text-muted-foreground">{change.before}</s>
                    ) : (
                      change.after
                    )}
                  </span>
                  {conflictId === change.id ? (
                    <span className="shrink-0 text-body-sm text-muted-foreground">
                      <Trans>Changed since</Trans>
                    </span>
                  ) : (
                    <Button
                      id={buttonId}
                      variant="ghost"
                      size="sm"
                      type="button"
                      aria-labelledby={`${buttonId} ${lineId}`}
                      disabled={undo.pending}
                      onClick={() => undo.run(change.id)}
                      className="-me-2 shrink-0 text-muted-foreground"
                    >
                      <Trans>Undo</Trans>
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}
