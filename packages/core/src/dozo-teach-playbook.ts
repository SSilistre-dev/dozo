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

function describePointer(event: TeachRecordingEvent): string {
  const action = event.type ?? "click";
  const button = event.button ?? "left";
  const at = `(${event.x ?? 0}, ${event.y ?? 0})`;
  if (action === "move") return `Move pointer to ${at}.`;
  if (action === "down") return `Press ${button} button at ${at}.`;
  if (action === "up") return `Release ${button} button at ${at}.`;
  return `${action === "click" ? "Click" : action} ${button} button at ${at}.`;
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
} {
  const steps: string[] = [];
  const values: TeachTypedValue[] = [];
  let typed = "";
  let typedSensitive = false;
  let drag: { button: string; fromX: number; fromY: number; toX: number; toY: number } | null =
    null;

  function addValue(text: string | null) {
    const placeholder = placeholderOf(values.length + 1);
    values.push({ placeholder, text, secret: text === null || SECRET_TEXT.test(text) });
    steps.push(`Type ${placeholder}.`);
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
    steps.push(
      moved
        ? `Drag ${drag.button} button from (${drag.fromX}, ${drag.fromY}) to (${drag.toX}, ${drag.toY}).`
        : `Click ${drag.button} button at (${drag.fromX}, ${drag.fromY}).`,
    );
    drag = null;
  }

  function pointer(event: TeachRecordingEvent) {
    const action = event.type ?? "click";
    const x = event.x ?? 0;
    const y = event.y ?? 0;
    if (action === "down") {
      flushDrag();
      drag = { button: event.button ?? "left", fromX: x, fromY: y, toX: x, toY: y };
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
    steps.push(describePointer(event));
  }

  for (const event of events) {
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
      if (key.length === 1) {
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
      pointer(event);
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
  return { steps, values };
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
