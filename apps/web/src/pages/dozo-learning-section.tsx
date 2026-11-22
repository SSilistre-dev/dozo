import { Trans } from "@lingui/react/macro";
import type { DozoLearningMode } from "@rakazo/contracts";
import { DOZO_LEARNING_CHANGED_CODE } from "@rakazo/contracts";
import { Button, SectionHeading } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useId } from "react";
import { errorText, toastError } from "../lib/dozo-error-text";
import { useSave, useSpaceQueries } from "../lib/query";
import { errorCode } from "../lib/user-error";
import { SettingsCard, SwitchRow } from "./shell/bot-settings-sections";

function changedSince(error: Error | null): boolean {
  return errorCode(error) === DOZO_LEARNING_CHANGED_CODE;
}

/**
 * Under the bot's memory: whether it learns from its owner's chat, and the lines it learned, each
 * to undo. Nothing when the setting cannot be read (a server without it).
 */
export function DozoLearningSection({ botId }: { botId: string }) {
  const ids = useId();
  const queries = useSpaceQueries();
  const learning = queries.dozoLearning.get.queryOptions({ input: { botId } });
  // Reviews write as the bot runs, so every open reads again, as the memory list does.
  const read = useQuery({ ...learning, refetchOnMount: "always" });
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
  if (!read.data) return null;
  const on = mode.pending ? mode.input === "auto" : read.data.mode === "auto";
  const changes = read.data.changes.filter((change) => !change.undoneAt);
  const conflictId = !undo.pending && changedSince(undo.error) ? undo.input : undefined;
  return (
    <section data-testid="bot-learning">
      <SettingsCard>
        <SwitchRow
          id={`${ids}-learn`}
          label={<Trans>Learn from chats</Trans>}
          checked={on}
          disabled={mode.pending}
          onChange={(checked) => mode.run(checked ? "auto" : "off")}
        />
      </SettingsCard>
      {changes.length ? (
        <>
          <SectionHeading variant="label" className="mt-6 mb-2">
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
