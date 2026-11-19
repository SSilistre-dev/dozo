import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoTeachValue, DozoTeachValueDecision, SkillPlaybook } from "@rakazo/contracts";
import { formatSkillRunPrompt, TEACH_NAME_TAKEN } from "@rakazo/core";
import { Button, Input, Label, Textarea, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useId, useRef, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorCode, errorText } from "../../lib/user-error";
import { BuiCard } from "../ai/primitives";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

type Action = DozoTeachValueDecision["action"];
type Choice = { action: Action; name: string };

/** What a draft is saved or tested with: its fields and a decision for each typed value. */
type Sent = {
  fields: string;
  name: string;
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
};

function fieldsOf(block: SkillDraftBlock): string {
  return JSON.stringify({ name: block.name, playbook: block.playbook });
}

function savedSnapshot(block: SkillDraftBlock): string | null {
  return block.status === "saved" ? fieldsOf(block) : null;
}

function fieldLabel(id: string, title: React.ReactNode) {
  return (
    <Label htmlFor={id} className="mt-3 mb-1 text-body-sm font-normal text-muted-foreground">
      {title}
    </Label>
  );
}

/** `{{value 3}}` names its input `value_3` until the teacher or the suggestion names it. */
function defaultName(placeholder: string): string {
  return `value_${placeholder.replace(/\D/g, "")}`;
}

/**
 * Every value is an input by default, hidden when it was typed as protected input: nothing typed
 * is kept in the skill unless the teacher picks Fixed, since a password typed into an unprotected
 * field cannot be told apart.
 */
function defaultChoice(value: DozoTeachValue): Choice {
  const name = value.suggestion?.name || defaultName(value.placeholder);
  return { action: value.secret ? "hidden" : "variable", name };
}

function decisionOf(placeholder: string, choice: Choice): DozoTeachValueDecision {
  if (choice.action === "fixed" || choice.action === "remove") return { action: choice.action };
  return { action: choice.action, name: choice.name.trim() || defaultName(placeholder) };
}

/**
 * Upstream's draft card, with the values typed while teaching shown to the teacher one by one:
 * each becomes an input asked for on each run, an input typed from a saved login (hidden), stays
 * as typed, or is dropped. Save and Test send
 * those decisions; until the values are known, neither is offered, so none is saved unseen.
 */
export function SkillDraftCard({
  block,
  onRefresh,
  onAddRoutine,
}: {
  block: SkillDraftBlock;
  onRefresh: () => Promise<void>;
  onAddRoutine: (name: string, prompt: string) => void;
}) {
  const { t } = useLingui();
  const id = useId();
  const queries = useSpaceQueries();
  const [name, setName] = useState(block.name);
  const [playbook, setPlaybook] = useState(block.playbook);
  // What the server last saved; "Saved" shows only while the fields still match it.
  const [savedFields, setSavedFields] = useState(savedSnapshot(block));
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  // Once saved, the server has forgotten the values and the steps hold the decisions.
  const [decided, setDecided] = useState(false);
  const saved = savedFields === JSON.stringify({ name, playbook });

  // Only the teacher of a draft gets values back. Never kept once the card is gone.
  const review = useQuery({
    ...queries.dozoTeach.review.queryOptions({ input: { skillId: block.skillId } }),
    enabled: block.status === "draft" && !decided,
    gcTime: 0,
  });
  const reviewing = block.status === "draft" && !decided;
  const values = reviewing ? (review.data?.values ?? []) : [];
  const reviewBlocked = reviewing && !review.data;
  // Until the typed values are saved with their decisions, a routine would carry `{{value N}}`.
  const undecided = reviewBlocked || values.length > 0;

  // The fields last loaded from the server, and whether this card has written since. A later
  // update to the same skill never replaces fields this card wrote or the user edited, so a
  // late or out-of-order saved status cannot bring back older values.
  const synced = useRef({ skillId: block.skillId, fields: fieldsOf(block), wrote: false });

  useEffect(() => {
    const sameSkill = synced.current.skillId === block.skillId;
    if (sameSkill && synced.current.wrote) {
      if (block.status === "saved") setSavedFields((current) => current ?? fieldsOf(block));
      return;
    }
    setSavedFields(savedSnapshot(block));
    if (sameSkill && synced.current.fields !== JSON.stringify({ name, playbook })) return;
    synced.current = { skillId: block.skillId, fields: fieldsOf(block), wrote: false };
    setName(block.name);
    setPlaybook(block.playbook);
  }, [block.skillId, block.status]);

  const choiceOf = (value: DozoTeachValue) => choices[value.placeholder] ?? defaultChoice(value);
  const setChoice = (placeholder: string, choice: Choice) =>
    setChoices((current) => ({ ...current, [placeholder]: choice }));

  function sent(): Sent {
    const decisions = Object.fromEntries(
      values.map((value) => [value.placeholder, decisionOf(value.placeholder, choiceOf(value))]),
    );
    return { fields: JSON.stringify({ name, playbook }), name, playbook, decisions };
  }

  const draft = (input: Sent) => ({
    skillId: block.skillId,
    name: input.name,
    playbook: input.playbook,
    decisions: input.decisions,
  });

  // The write already succeeded, so a failed thread refresh is not reported as its failure.
  const refresh = () => onRefresh().catch(() => undefined);

  const save = useSave({
    save: (input: Sent, rpc) => rpc.dozoTeach.save(draft(input)),
    stale: [queries.skills.list.key()],
    onSaved: async (skill, input) => {
      synced.current.wrote = true;
      setDecided(true);
      setPlaybook(skill.playbook);
      setSavedFields(JSON.stringify({ name: input.name, playbook: skill.playbook }));
      await refresh();
    },
  });

  const test = useSave({
    save: (input: Sent, rpc) => rpc.dozoTeach.test(draft(input)),
    onSaved: async (_run, input) => {
      synced.current.wrote = true;
      // A saved skill stays saved with the fields just written.
      if (savedFields !== null) setSavedFields(input.fields);
      await refresh();
    },
  });

  const busy = save.pending || test.pending;
  const failed = save.error ?? test.error;
  const error =
    failed && errorCode(failed) === TEACH_NAME_TAKEN
      ? t`Each name can be used once.`
      : save.error
        ? errorText(save.error, t`Could not save skill`)
        : test.error
          ? errorText(test.error)
          : reviewing && review.isError
            ? t`Could not load`
            : null;

  const skillName = name || block.name || block.goal.slice(0, 80);

  return (
    <BuiCard data-testid="skill-draft-card" className="w-[520px] max-w-full px-5 py-4">
      <div className="text-body-lg font-medium text-foreground">
        <Trans>Draft skill</Trans>
      </div>
      <div className="mt-1 text-body text-muted-foreground">{block.goal}</div>
      {fieldLabel(`${id}-name`, <Trans>Name</Trans>)}
      <Input
        id={`${id}-name`}
        disabled={busy}
        value={name}
        onChange={(event) => setName(event.target.value)}
      />
      {fieldLabel(`${id}-when`, <Trans>When to use</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-when`}
        value={playbook.whenToUse}
        onChange={(event) => setPlaybook({ ...playbook, whenToUse: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-inputs`, <Trans>Inputs</Trans>)}
      {values.length ? (
        <div id={`${id}-inputs`} className="flex flex-col gap-2">
          {values.map((value) => {
            const choice = choiceOf(value);
            // Protected input and text that could not be rebuilt are never shown or kept.
            const hidden = value.secret || value.text === null;
            const named = choice.action === "variable" || choice.action === "hidden";
            return (
              <div key={value.placeholder} data-testid="skill-draft-value">
                <div className="flex items-center gap-2">
                  <span
                    dir="auto"
                    className="w-28 shrink-0 break-words text-body-sm text-muted-foreground"
                  >
                    {hidden ? "••••••" : value.text}
                  </span>
                  {named ? (
                    <Input
                      aria-label={t`Name`}
                      disabled={busy}
                      className="min-w-0 flex-1"
                      value={choice.name}
                      onChange={(event) =>
                        setChoice(value.placeholder, { ...choice, name: event.target.value })
                      }
                    />
                  ) : (
                    <span className="flex-1" />
                  )}
                  <ToggleGroup
                    value={[choice.action]}
                    disabled={busy}
                    onValueChange={([next]) => {
                      if (next) setChoice(value.placeholder, { ...choice, action: next as Action });
                    }}
                    spacing={0}
                    size="sm"
                    variant="outline"
                  >
                    <ToggleGroupItem value="variable">
                      <Trans>Variable</Trans>
                    </ToggleGroupItem>
                    <ToggleGroupItem value="hidden">
                      <Trans>Hidden</Trans>
                    </ToggleGroupItem>
                    {hidden ? null : (
                      <ToggleGroupItem value="fixed">
                        <Trans>Fixed</Trans>
                      </ToggleGroupItem>
                    )}
                    <ToggleGroupItem value="remove">
                      <Trans>Remove</Trans>
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
                {choice.action === "fixed" ? (
                  <p className="mt-1 text-label text-muted-foreground">
                    <Trans>Saved in the steps, visible to everyone in this space.</Trans>
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <Textarea
          disabled={busy}
          id={`${id}-inputs`}
          value={playbook.inputs.join("\n")}
          onChange={(event) =>
            setPlaybook({
              ...playbook,
              inputs: event.target.value.split("\n"),
            })
          }
          rows={2}
        />
      )}
      {fieldLabel(`${id}-steps`, <Trans>Steps</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-steps`}
        value={playbook.steps.join("\n")}
        onChange={(event) =>
          setPlaybook({
            ...playbook,
            steps: event.target.value.split("\n"),
          })
        }
        rows={5}
      />
      {fieldLabel(`${id}-check`, <Trans>How to check</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-check`}
        value={playbook.howToCheck}
        onChange={(event) => setPlaybook({ ...playbook, howToCheck: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-return`, <Trans>What to return</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-return`}
        value={playbook.whatToReturn}
        onChange={(event) => setPlaybook({ ...playbook, whatToReturn: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-approval`, <Trans>Approval boundaries</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-approval`}
        value={playbook.approvalBoundaries}
        onChange={(event) => setPlaybook({ ...playbook, approvalBoundaries: event.target.value })}
        rows={2}
      />
      {fieldLabel(`${id}-failure`, <Trans>Failure handling</Trans>)}
      <Textarea
        disabled={busy}
        id={`${id}-failure`}
        value={playbook.failureHandling}
        onChange={(event) => setPlaybook({ ...playbook, failureHandling: event.target.value })}
        rows={2}
      />
      <div className="mt-4 flex flex-wrap gap-2">
        <Button disabled={busy || reviewBlocked} onClick={() => save.run(sent())}>
          {saved ? <Trans>Saved</Trans> : busy ? <Trans>Saving…</Trans> : <Trans>Save</Trans>}
        </Button>
        <Button variant="outline" disabled={busy || reviewBlocked} onClick={() => test.run(sent())}>
          <Trans>Test</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={busy || undecided}
          onClick={() => onAddRoutine(skillName, formatSkillRunPrompt(skillName, playbook))}
        >
          <Trans>Add to routine</Trans>
        </Button>
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
