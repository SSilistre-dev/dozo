import { ClientError } from "./client-error.js";
import { skillGivenInputs, skillInputsInstruction } from "./dozo-teach-playbook.prompt.js";
import type { SkillPlaybook, TeachRecordingEvent, TeachSnapshot } from "./teach-playbook.js";
import {
  scrollDirection,
  formatSkillRunPrompt as upstreamFormatSkillRunPrompt,
} from "./teach-playbook.js";
import {
  DEFAULT_APPROVAL,
  DEFAULT_FAILURE,
  DEFAULT_STEP,
  DEFAULT_WHAT_TO_RETURN,
  DEFAULT_WHEN_TO_USE,
  playbookHowToCheck,
} from "./teach-playbook.prompt.js";

// Upstream's module, with the two names below replaced: local exports win over a star re-export.
export * from "./teach-playbook.js";

/**
 * A value typed or pasted while teaching. Its text never enters the playbook: the steps hold
 * `placeholder` (`{{value N}}`, numbered in the order typed) until the teacher decides what it is.
 * Protected input has no text, and it and text that looks like a password are secret.
 */
export type TeachTypedValue = {
  placeholder: string;
  text: string | null;
  secret: boolean;
};

/**
 * A click step of the recording: the event it came from (a plain click, or a press and release
 * in place), the step as first written, and the value typed next, if any.
 */
type TeachClick = {
  eventIndex: number;
  step: string;
  button: string;
  x: number;
  y: number;
  value?: string;
};

/** What a recorded click hit, as the save writes it into its step. */
export type TeachClickTarget = { eventIndex: number; window?: string; label?: string };

/** What the teacher decided for one typed value. */
export type TeachValueDecision =
  | { action: "variable"; name: string }
  | { action: "fixed" }
  | { action: "remove" };

const SECRET_TEXT = /password|secret|token|api[_-]?key/i;
/** How a secret input is listed in `inputs`, so the run prompt can tell it apart. */
const SECRET_MARK = " (secret)";
const PLACEHOLDER_LABEL = /^value \d+(?: \(secret\))?$/;
const INPUT_IN_STEP = /\{\{([^{}]+)\}\}/g;
const NAME_MAX = 40;

function placeholderOf(index: number): string {
  return `{{value ${index}}}`;
}

/** A click step as the builder writes it, before anything says what was clicked. */
function clickStep(button: string, x: number, y: number): string {
  return `Click ${button} button at (${x}, ${y}).`;
}

function describePointer(event: TeachRecordingEvent): string {
  const action = event.type ?? "click";
  const button = event.button ?? "left";
  const at = `(${event.x ?? 0}, ${event.y ?? 0})`;
  if (action === "move") return `Move pointer to ${at}.`;
  if (action === "down") return `Press ${button} button at ${at}.`;
  if (action === "up") return `Release ${button} button at ${at}.`;
  if (action === "click") return clickStep(button, event.x ?? 0, event.y ?? 0);
  return `${action} ${button} button at ${at}.`;
}

function describeScroll(event: TeachRecordingEvent): string {
  const direction = scrollDirection(event.type);
  const amount = Number(event.text ?? 3);
  const at = event.x !== undefined && event.y !== undefined ? ` at (${event.x}, ${event.y})` : "";
  return Number.isFinite(amount) && amount > 1
    ? `Scroll ${direction} ${amount} times${at}.`
    : `Scroll ${direction}${at}.`;
}

/**
 * The one walk over a recording: upstream's steps, with every typed run, pasted text and protected
 * run replaced by its placeholder. The playbook and the value list both come from here, so their
 * numbering cannot drift apart.
 */
function walkRecording(events: TeachRecordingEvent[]): {
  steps: string[];
  values: TeachTypedValue[];
  clicks: TeachClick[];
} {
  const steps: string[] = [];
  const values: TeachTypedValue[] = [];
  const clicks: TeachClick[] = [];
  let typed = "";
  let typedSensitive = false;
  let drag: {
    eventIndex: number;
    button: string;
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
  } | null = null;
  // The last click step, until a value is typed after it.
  let lastClick: TeachClick | null = null;

  function addValue(text: string | null) {
    const placeholder = placeholderOf(values.length + 1);
    values.push({ placeholder, text, secret: text === null || SECRET_TEXT.test(text) });
    steps.push(`Type ${placeholder}.`);
    if (lastClick) lastClick.value = placeholder;
    lastClick = null;
  }

  function addClick(eventIndex: number, button: string, x: number, y: number) {
    const step = clickStep(button, x, y);
    lastClick = { eventIndex, step, button, x, y };
    clicks.push(lastClick);
    steps.push(step);
  }

  function flushTyped() {
    if (typed) addValue(typed);
    typed = "";
  }

  function flushSensitiveTyped() {
    if (typedSensitive) addValue(null);
    typedSensitive = false;
  }

  function flushPendingInput() {
    flushTyped();
    flushSensitiveTyped();
  }

  function flushDrag() {
    if (!drag) return;
    const moved = Math.hypot(drag.toX - drag.fromX, drag.toY - drag.fromY) >= 8;
    if (moved) {
      steps.push(
        `Drag ${drag.button} button from (${drag.fromX}, ${drag.fromY}) to (${drag.toX}, ${drag.toY}).`,
      );
    } else {
      addClick(drag.eventIndex, drag.button, drag.fromX, drag.fromY);
    }
    drag = null;
  }

  function pointer(event: TeachRecordingEvent, eventIndex: number) {
    const action = event.type ?? "click";
    const x = event.x ?? 0;
    const y = event.y ?? 0;
    if (action === "down") {
      flushDrag();
      drag = { eventIndex, button: event.button ?? "left", fromX: x, fromY: y, toX: x, toY: y };
      return;
    }
    if (action === "move" && drag) {
      drag.toX = x;
      drag.toY = y;
      return;
    }
    if (action === "up" && drag) {
      drag.toX = x;
      drag.toY = y;
      flushDrag();
      return;
    }
    flushDrag();
    if (action === "click") addClick(eventIndex, event.button ?? "left", x, y);
    else steps.push(describePointer(event));
  }

  for (const [index, event] of events.entries()) {
    if (event.kind === "key") {
      if (event.sensitive) {
        flushDrag();
        flushTyped();
        typedSensitive = true;
        continue;
      }
      const key = event.key;
      if (!key) continue;
      flushDrag();
      // One character, counted in code points: an emoji is two UTF-16 units but still typed text.
      if ([...key].length === 1) {
        flushSensitiveTyped();
        typed += key;
        continue;
      }
      flushPendingInput();
      steps.push(`Press key: ${key}.`);
      continue;
    }
    flushPendingInput();
    if (event.kind === "pointer") {
      pointer(event, index);
      continue;
    }
    flushDrag();
    if (event.kind === "clipboard") {
      if (event.sensitive) addValue(null);
      else if (event.text) addValue(event.text);
    } else if (event.kind === "scroll") {
      steps.push(describeScroll(event));
    }
  }
  flushPendingInput();
  flushDrag();
  return { steps, values, clicks };
}

function inputLabel(name: string, secret: boolean): string {
  return secret ? `${name}${SECRET_MARK}` : name;
}

/**
 * Upstream's playbook, except that no typed or pasted text enters it: each value is a
 * `{{value N}}` placeholder, listed after the goal in `inputs` (marked when secret).
 */
export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const { steps, values } = walkRecording(events);
  const trimmed = goal.trim();
  return {
    whenToUse: trimmed || DEFAULT_WHEN_TO_USE,
    inputs: [
      ...(trimmed ? [trimmed] : []),
      ...values.map((value) => inputLabel(value.placeholder.slice(2, -2), value.secret)),
    ],
    steps: steps.length ? steps : [DEFAULT_STEP],
    howToCheck: playbookHowToCheck(snapshots.at(-1)?.summary),
    whatToReturn: DEFAULT_WHAT_TO_RETURN,
    approvalBoundaries: DEFAULT_APPROVAL,
    failureHandling: DEFAULT_FAILURE,
  };
}

/** The values typed while teaching, numbered as the playbook's placeholders are. */
export function typedValuesFromRecording(events: TeachRecordingEvent[]): TeachTypedValue[] {
  return walkRecording(events).values;
}

/**
 * The events of the clicks whose next typed value is secret: by the recording's own rule, or
 * one of `alsoSecret` (placeholders). A picture of what such a click hit is never kept.
 */
export function clicksBeforeSecrets(
  events: TeachRecordingEvent[],
  alsoSecret: Iterable<string> = [],
): Set<number> {
  const { values, clicks } = walkRecording(events);
  const secret = new Set(alsoSecret);
  for (const value of values) if (value.secret) secret.add(value.placeholder);
  return new Set(
    clicks.flatMap((click) =>
      click.value !== undefined && secret.has(click.value) ? [click.eventIndex] : [],
    ),
  );
}

/**
 * Where each click's step is in `steps`, by event: matched in order by the words the builder
 * wrote, so a step the teacher rewrote or removed has none.
 */
export function clickStepIndexes(
  steps: string[],
  events: TeachRecordingEvent[],
): Map<number, number> {
  const indexes = new Map<number, number>();
  let from = 0;
  for (const click of walkRecording(events).clicks) {
    const at = steps.indexOf(click.step, from);
    if (at < 0) continue;
    indexes.set(click.eventIndex, at);
    from = at + 1;
  }
  return indexes;
}

const LABEL_MAX = 60;
const WINDOW_MAX = 80;

/** Model or window text made safe to quote in a step: one line, no input braces. */
function quoted(text: string | undefined, max: number): string | undefined {
  const clean = text
    ?.replace(/[\p{Cc}{}"]/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .trim();
  return clean ? `"${clean}"` : undefined;
}

function describeClick(click: TeachClick, target: TeachClickTarget): string {
  const label = quoted(target.label, LABEL_MAX);
  const window = quoted(target.window, WINDOW_MAX);
  if (!label && !window) return click.step;
  const verb =
    click.button === "left"
      ? "Click"
      : `${click.button.charAt(0).toUpperCase()}${click.button.slice(1)}-click`;
  return [verb, label, window && `in ${window}`, `(near ${click.x}, ${click.y}).`]
    .filter(Boolean)
    .join(" ");
}

/**
 * Says in each click's step what it hit, as `Click "Submit button" in "Form" (near 208, 206).`:
 * the thing clicked is what to look for, the coordinate only a hint. A step the teacher rewrote
 * stays as written.
 */
export function withClickTargets(
  playbook: SkillPlaybook,
  events: TeachRecordingEvent[],
  targets: TeachClickTarget[],
): SkillPlaybook {
  const clicks = new Map(walkRecording(events).clicks.map((click) => [click.eventIndex, click]));
  const indexes = clickStepIndexes(playbook.steps, events);
  const steps = [...playbook.steps];
  for (const target of targets) {
    const click = clicks.get(target.eventIndex);
    const at = indexes.get(target.eventIndex);
    if (click && at !== undefined) steps[at] = describeClick(click, target);
  }
  return { ...playbook, steps };
}

/** Lowercase letters, digits and underscores, at most 40; accents are dropped, not the letter. */
export function teachInputName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/ı/g, "i")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, NAME_MAX)
    .replace(/_+$/, "");
}

/**
 * Applies the teacher's decision to each typed value: an input the bot fills on each run, text
 * kept in the steps, or the steps that type it removed. A value with no decision is an input
 * named `value_N`. Secret values are never kept as text. Values the steps no longer hold are
 * left alone.
 */
export function applyValueDecisions(
  playbook: SkillPlaybook,
  values: TeachTypedValue[],
  decisions: Record<string, TeachValueDecision | undefined>,
): SkillPlaybook {
  let steps = [...playbook.steps];
  const variables = new Map<string, boolean>();
  values.forEach((value, index) => {
    // A value whose steps were edited away is no input.
    if (!steps.some((step) => step.includes(value.placeholder))) return;
    const decision = decisions[value.placeholder] ?? { action: "variable", name: "" };
    if (decision.action === "remove") {
      steps = steps.filter((step) => !step.includes(value.placeholder));
      return;
    }
    if (decision.action === "fixed") {
      if (value.secret || value.text === null) {
        throw new ClientError("BAD_REQUEST", "A secret value cannot be kept in the skill");
      }
      const text = JSON.stringify(value.text);
      steps = steps.map((step) => step.replaceAll(value.placeholder, text));
      return;
    }
    const name = teachInputName(decision.name) || `value_${index + 1}`;
    // A value the teacher names like a password is secret too.
    const secret = value.secret || SECRET_TEXT.test(name);
    variables.set(name, (variables.get(name) ?? false) || secret);
    steps = steps.map((step) => step.replaceAll(value.placeholder, `{{${name}}}`));
  });
  const inputs = variables.size
    ? [...variables].map(([name, secret]) => inputLabel(name, secret))
    : playbook.inputs.filter((input) => !PLACEHOLDER_LABEL.test(input));
  return { ...playbook, inputs, steps: steps.length ? steps : [DEFAULT_STEP] };
}

/** The `{{name}}` inputs the steps use, in order, and whether `inputs` marks each secret. */
function stepInputs(playbook: SkillPlaybook): Array<{ name: string; secret: boolean }> {
  const names = new Set<string>();
  for (const step of playbook.steps) {
    for (const match of step.matchAll(INPUT_IN_STEP)) names.add(match[1]!.trim());
  }
  return [...names].map((name) => ({
    name,
    secret: playbook.inputs.includes(inputLabel(name, true)),
  }));
}

/**
 * Upstream's run prompt, plus how to fill the steps' inputs when they have any, and the values
 * given for this run. A secret input's value is never written into the prompt.
 */
export function formatSkillRunPrompt(
  name: string,
  playbook: SkillPlaybook,
  test = false,
  values?: Record<string, string>,
): string {
  const prompt = upstreamFormatSkillRunPrompt(name, playbook, test);
  const inputs = stepInputs(playbook);
  if (!inputs.length) return prompt;
  const given = inputs.flatMap((input) => {
    const value = values?.[input.name];
    return !input.secret && value !== undefined ? [[input.name, value] as [string, string]] : [];
  });
  return [prompt, skillInputsInstruction(inputs), given.length ? skillGivenInputs(given) : ""]
    .filter(Boolean)
    .join("\n");
}
