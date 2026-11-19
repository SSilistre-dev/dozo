import { Trans, useLingui } from "@lingui/react/macro";
import type { DozoTeachValue, DozoTeachValueDecision, SkillPlaybook } from "@rakazo/contracts";
import { formatSkillRunPrompt, TEACH_NAME_TAKEN, TEACH_SKILL_GONE } from "@rakazo/core";
import { Button, Input, Label, Switch, Textarea } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { XIcon } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { useSave, useSpaceQueries } from "../../lib/query";
import { errorCode, errorText } from "../../lib/user-error";
import { BuiCard } from "../ai/primitives";
import { DeleteSkill } from "./dozo-delete-skill";
import type { TeachValueChoice } from "./dozo-teach-value-row";
import { defaultValueName, TeachValueRow, valueDecisionOf } from "./dozo-teach-value-row";

type SkillDraftBlock = {
  kind: "skill_draft";
  skillId: string;
  name: string;
  goal: string;
  playbook: SkillPlaybook;
  status: "draft" | "saved";
};

type Choice = TeachValueChoice;

/** What a draft is saved or tested with: its fields, a decision for each typed value, the
 * clicked pictures the teacher took away, and the labels they kept. */
type Sent = {
  fields: string;
  name: string;
  playbook: SkillPlaybook;
  decisions: Record<string, DozoTeachValueDecision>;
  removedTargets: string[];
  labels: Record<string, string>;
};

/** What a step may quote of a label: one line, no input braces or quotes, 60 characters. */
const LABEL_MAX = 60;
const plainLabel = (text: string) => text.replace(/[{}"\p{Cc}]/gu, "").slice(0, LABEL_MAX);

/** Skills this page learned are deleted, so their cards stop asking whenever they mount. */
const goneSkills = new Set<string>();

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

/**
 * Every value is an input by default, hidden when it was typed as protected input: nothing typed
 * is kept in the skill unless the teacher picks Fixed, since a password typed into an unprotected
 * field cannot be told apart.
 */
function defaultChoice(value: DozoTeachValue): Choice {
  const name = value.suggestion?.name || defaultValueName(value.placeholder);
  return { action: value.secret ? "hidden" : "variable", name };
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
  const [removedTargets, setRemovedTargets] = useState<string[]>([]);
  // Nothing about the pictures goes to the model unless the teacher turns this on; the labels it
  // gives are shown, editable, and only those kept are saved.
  const [nameSteps, setNameSteps] = useState(false);
  const [labels, setLabels] = useState<Record<string, string>>({});
  const saved = savedFields === JSON.stringify({ name, playbook });

  // Deleted from this card, or known gone from an earlier mount: never asked about again.
  const [deleted, setDeleted] = useState(() => goneSkills.has(block.skillId));
  // Only the teacher of a draft gets values back. Never kept once the card is gone. Read for a
  // saved skill too, as it tells whether the skill still exists; that answer is final.
  const review = useQuery({
    ...queries.dozoTeach.review.queryOptions({ input: { skillId: block.skillId } }),
    enabled: !deleted,
    gcTime: 0,
  });
  const gone = deleted || errorCode(review.error) === TEACH_SKILL_GONE;
  if (gone) goneSkills.add(block.skillId);
  const reviewing = block.status === "draft" && !decided;
  const values = reviewing ? (review.data?.values ?? []) : [];
  const targets = (reviewing ? (review.data?.targets ?? []) : []).filter(
    (target) => target.image && !removedTargets.includes(target.id),
  );
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
      values.map((value) => [
        value.placeholder,
        valueDecisionOf(value.placeholder, choiceOf(value)),
      ]),
    );
    const shown = new Set(targets.map((target) => target.id));
    return {
      fields: JSON.stringify({ name, playbook }),
      name,
      playbook,
      decisions,
      removedTargets,
      labels: nameSteps
        ? Object.fromEntries(
            Object.entries(labels).flatMap(([target, label]) =>
              shown.has(target) && label.trim() ? [[target, label.trim()]] : [],
            ),
          )
        : {},
    };
  }

  const draft = (input: Sent) => ({
    skillId: block.skillId,
    name: input.name,
    playbook: input.playbook,
    decisions: input.decisions,
    removedTargets: input.removedTargets,
    labels: input.labels,
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

  // A removed picture is forgotten on the server at once, not only left out of the save.
  const removeTarget = useSave({
    save: (target: string, rpc) =>
      rpc.dozoTeach.removeTarget({ skillId: block.skillId, targetId: target }),
    onSaved: (_done, target) => {
      setRemovedTargets((current) => [...current, target]);
      setLabels(({ [target]: _gone, ...rest }) => rest);
    },
  });

  const nameTargets = useSave<void, { labels: Record<string, string> }>({
    save: (_input, rpc) =>
      rpc.dozoTeach.labelTargets({ skillId: block.skillId, decisions: sent().decisions }),
    onSaved: (named) =>
      setLabels(
        Object.fromEntries(
          Object.entries(named.labels).map(([target, label]) => [target, plainLabel(label)]),
        ),
      ),
  });

  function turnNameSteps(on: boolean) {
    setNameSteps(on);
    setLabels({});
    if (on) nameTargets.run();
  }

  const busy = save.pending || test.pending || removeTarget.pending;
  const failed = save.error ?? test.error;
  const error =
    failed && errorCode(failed) === TEACH_NAME_TAKEN
      ? t`Each name can be used once.`
      : save.error
        ? errorText(save.error, t`Could not save skill`)
        : test.error
          ? errorText(test.error)
          : removeTarget.error
            ? errorText(removeTarget.error)
            : (reviewing && review.isError) || nameTargets.error
              ? t`Could not load`
              : null;

  const skillName = name || block.name || block.goal.slice(0, 80);

  if (gone) {
    return (
      <BuiCard data-testid="skill-draft-card" className="w-[520px] max-w-full px-5 py-4">
        <div dir="auto" className="truncate text-body-lg font-medium text-foreground">
          {block.name || block.goal}
        </div>
        <div className="mt-1 text-body text-muted-foreground">
          <Trans>Deleted</Trans>
        </div>
      </BuiCard>
    );
  }

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
          {values.map((value) => (
            <TeachValueRow
              key={value.placeholder}
              value={value}
              choice={choiceOf(value)}
              busy={busy}
              onChange={(choice) => setChoice(value.placeholder, choice)}
            />
          ))}
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
      {targets.length ? (
        <>
          <div className="mt-3 flex flex-wrap gap-3">
            {targets.map((target) => {
              // What the button removes: the step the picture belongs to.
              const label = playbook.steps[target.step] ?? "";
              return (
                <figure
                  key={target.id}
                  data-testid="skill-draft-target"
                  className="relative m-0 flex w-40 flex-col gap-1"
                >
                  <img
                    src={target.image}
                    alt=""
                    className="block h-auto max-h-24 w-auto max-w-40 rounded-md border border-border object-contain"
                  />
                  <Button
                    variant="secondary"
                    size="icon-sm"
                    aria-label={t`Remove ${label}`}
                    disabled={busy}
                    className="absolute -top-2 -right-2 size-6 rounded-full border border-border"
                    onClick={() => removeTarget.run(target.id)}
                  >
                    <XIcon className="size-3" />
                  </Button>
                  {nameSteps && !nameTargets.pending ? (
                    <Input
                      aria-label={label}
                      disabled={busy}
                      value={labels[target.id] ?? ""}
                      maxLength={LABEL_MAX}
                      className="h-7 text-body-sm"
                      onChange={(event) =>
                        setLabels((current) => ({
                          ...current,
                          [target.id]: plainLabel(event.target.value),
                        }))
                      }
                    />
                  ) : null}
                </figure>
              );
            })}
          </div>
          <Label className="mt-2 flex items-center gap-2 text-body-sm font-normal text-muted-foreground">
            <Switch
              size="sm"
              checked={nameSteps}
              disabled={busy || nameTargets.pending}
              onCheckedChange={turnNameSteps}
            />
            <Trans>Send these images to the model to name the steps</Trans>
          </Label>
        </>
      ) : null}
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
        {reviewing ? (
          <DeleteSkill
            skillId={block.skillId}
            name={skillName}
            onDeleted={() => setDeleted(true)}
          />
        ) : null}
      </div>
      {error ? <p className="mt-2 text-label text-destructive">{error}</p> : null}
    </BuiCard>
  );
}
