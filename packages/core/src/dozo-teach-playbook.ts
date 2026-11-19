import { ClientError } from "./client-error.js";
import {
  SKILL_CLICK_TARGETS_NOTE,
  skillGivenInputs,
  skillInputsInstruction,
} from "./dozo-teach-playbook.prompt.js";
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
 * `secret` is the protected-input mark, the only thing besides the teacher's own choice that makes
 * a value secret. `text` is null for protected input (never stored) and for typing that cannot be
 * rebuilt safely (an edit outside what was typed, a protected paste in the middle).
 */
export type TeachTypedValue = {
  placeholder: string;
  text: string | null;
  secret: boolean;
};

/**
 * A click step of the recording: the event it came from (a plain click, or a press and release
 * in place), the step as first written, and the placeholder of the value typed next, if any.
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

/** What the teacher decided for one typed value; `hidden` is an input typed from a saved login. */
export type TeachValueDecision =
  | { action: "variable"; name: string }
  | { action: "hidden"; name: string }
  | { action: "fixed" }
  | { action: "remove" };

/**
 * A recorded event, plus the one shape the fork stores in place of a typed run once its text is
 * forgotten: `{ at, kind: "key", typed: true }` (and `sensitive` when it was protected).
 */
type RecordedEvent = TeachRecordingEvent & { typed?: boolean };

/** How a secret input is listed in `inputs`, so the run prompt can tell it apart. */
const SECRET_MARK = " (secret)";
const PLACEHOLDER_LABEL = /^value \d+(?: \(secret\))?$/;
const INPUT_IN_STEP = /\{\{([^{}]+)\}\}/g;
const NAME_MAX = 40;
/** Keys that edit the text being typed; outside a value they are steps of their own. */
const EDIT_KEYS = new Set(["Backspace", "Delete", "ArrowLeft", "ArrowRight", "Home", "End"]);
/** Keys that move to another line or entry: inside a value its text can no longer be known. */
const BLIND_KEYS = new Set(["ArrowUp", "ArrowDown"]);

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

/** One stretch of typing: the text rebuilt with its cursor, and the events it spans. */
type TypedRun = {
  chars: string[];
  cursor: number;
  protected: boolean;
  unknown: boolean;
  first: number;
  last: number;
};

/** The events of one typed run, and whether it left a value (an emptied field leaves none). */
type RunSpan = { first: number; last: number; value: TeachTypedValue | null };

/** Applies an editing key to the run; one reaching past what was typed makes its text unknown. */
function editRun(run: TypedRun, key: string) {
  const { chars, cursor } = run;
  if (key === "Home") run.cursor = 0;
  else if (key === "End") run.cursor = chars.length;
  else if (key === "Backspace" && cursor > 0) {
    chars.splice(cursor - 1, 1);
    run.cursor -= 1;
  } else if (key === "Delete" && cursor < chars.length) chars.splice(cursor, 1);
  else if (key === "ArrowLeft" && cursor > 0) run.cursor -= 1;
  else if (key === "ArrowRight" && cursor < chars.length) run.cursor += 1;
  else run.unknown = true;
}

/**
 * The one walk over a recording: upstream's steps, with every typed run (keys, pastes and
 * protected input in a row, with the edits made to them) replaced by its placeholder. Tab, Enter
 * and every other key end a run and stay steps. The playbook, the value list and the scrub all
 * come from here, so their numbering cannot drift apart.
 */
function walkRecording(events: RecordedEvent[]): {
  steps: string[];
  values: TeachTypedValue[];
  runs: RunSpan[];
  clicks: TeachClick[];
} {
  const steps: string[] = [];
  const values: TeachTypedValue[] = [];
  const runs: RunSpan[] = [];
  const clicks: TeachClick[] = [];
  let run: TypedRun | null = null;
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

  function addClick(eventIndex: number, button: string, x: number, y: number) {
    const step = clickStep(button, x, y);
    lastClick = { eventIndex, step, button, x, y };
    clicks.push(lastClick);
    steps.push(step);
  }

  function endRun() {
    if (!run) return;
    const blind = run.protected || run.unknown;
    let value: TeachTypedValue | null = null;
    if (blind || run.chars.length) {
      value = {
        placeholder: placeholderOf(values.length + 1),
        text: blind ? null : run.chars.join(""),
        secret: run.protected,
      };
      values.push(value);
      steps.push(`Type ${value.placeholder}.`);
      if (lastClick) lastClick.value = value.placeholder;
      lastClick = null;
    }
    runs.push({ first: run.first, last: run.last, value });
    run = null;
  }

  /** Adds the event at `index` to the current run, starting one if needed. */
  function joinRun(index: number): TypedRun {
    flushDrag();
    run ??= { chars: [], cursor: 0, protected: false, unknown: false, first: index, last: index };
    run.last = index;
    return run;
  }

  function insert(index: number, text: string) {
    const current = joinRun(index);
    // Counted in code points: an emoji is two UTF-16 units but one character typed.
    const chars = [...text];
    current.chars.splice(current.cursor, 0, ...chars);
    current.cursor += chars.length;
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

  function key(event: RecordedEvent, index: number) {
    if (event.typed || event.sensitive) {
      // A run whose text is already forgotten, or protected input: no text to rebuild.
      const current = joinRun(index);
      if (event.sensitive) current.protected = true;
      else current.unknown = true;
      return;
    }
    const name = event.key;
    if (!name) return;
    if ([...name].length === 1) {
      insert(index, name);
      return;
    }
    if (run && (EDIT_KEYS.has(name) || BLIND_KEYS.has(name))) {
      const current = joinRun(index);
      if (BLIND_KEYS.has(name)) current.unknown = true;
      else editRun(current, name);
      return;
    }
    endRun();
    flushDrag();
    steps.push(`Press key: ${name}.`);
  }

  events.forEach((event, index) => {
    if (event.kind === "key") {
      key(event, index);
      return;
    }
    if (event.kind === "clipboard") {
      if (event.sensitive) joinRun(index).protected = true;
      else if (event.text) insert(index, event.text);
      return;
    }
    endRun();
    if (event.kind === "pointer") {
      pointer(event, index);
      return;
    }
    flushDrag();
    if (event.kind === "scroll") steps.push(describeScroll(event));
  });
  endRun();
  flushDrag();
  return { steps, values, runs, clicks };
}

function inputLabel(name: string, secret: boolean): string {
  return secret ? `${name}${SECRET_MARK}` : name;
}

/** Where a window title names its application: after the last of these. */
const TITLE_SEPARATORS = [" - ", " \u2013 ", " \u2014 "];

/**
 * The application a window title names (its trailing " - App" or " — App" segment), or null when
 * it names none. The rest of a title can show what the person typed or opened (a search term, a
 * document, an address), so only this part is ever kept.
 */
export function teachAppName(title: string): string | null {
  const at = Math.max(...TITLE_SEPARATORS.map((separator) => title.lastIndexOf(separator)));
  if (at < 0) return null;
  const separator = TITLE_SEPARATORS.find((candidate) => title.startsWith(candidate, at))!;
  return title.slice(at + separator.length).trim() || null;
}

/**
 * Upstream's playbook, except that no typed or pasted text enters it: each value is a
 * `{{value N}}` placeholder, listed after the goal in `inputs` (marked when protected).
 */
export function buildPlaybookFromRecording(
  goal: string,
  events: TeachRecordingEvent[],
  snapshots: TeachSnapshot[] = [],
): SkillPlaybook {
  const { steps, values } = walkRecording(events);
  const trimmed = goal.trim();
  const title = snapshots.at(-1)?.summary;
  return {
    whenToUse: trimmed || DEFAULT_WHEN_TO_USE,
    inputs: [
      ...(trimmed ? [trimmed] : []),
      ...values.map((value) => inputLabel(value.placeholder.slice(2, -2), value.secret)),
    ],
    steps: steps.length ? steps : [DEFAULT_STEP],
    // The last window's application, never the rest of its title.
    howToCheck: playbookHowToCheck((title && teachAppName(title)) || undefined),
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
 * The events with what was typed forgotten: each typed run becomes one `{ at, kind: "key", typed:
 * true }` event at its first event's time (marked `sensitive` when protected), so neither its
 * text, its length nor its timing is left; a run that left no value is dropped. The steps and
 * their numbering built from the result are the same as from the original.
 */
export function scrubTeachEvents(events: TeachRecordingEvent[]): TeachRecordingEvent[] {
  return scrubTeachRecordingEvents(events).events;
}

/**
 * `scrubTeachEvents`, and where each event that is kept as it was (a click, a key step) is in
 * the result, by its index before: the clicks' targets move with them.
 */
export function scrubTeachRecordingEvents(events: TeachRecordingEvent[]): {
  events: TeachRecordingEvent[];
  indexOf: Map<number, number>;
} {
  const { runs } = walkRecording(events);
  const scrubbed: TeachRecordingEvent[] = [];
  const indexOf = new Map<number, number>();
  const keep = (from: number, to: number) => {
    for (let index = from; index < to; index += 1) {
      indexOf.set(index, scrubbed.length);
      scrubbed.push(events[index]!);
    }
  };
  let next = 0;
  for (const run of runs) {
    keep(next, run.first);
    if (run.value) {
      const marker: RecordedEvent = {
        at: events[run.first]!.at,
        kind: "key",
        typed: true,
        ...(run.value.secret ? { sensitive: true } : {}),
      };
      scrubbed.push(marker);
    }
    next = run.last + 1;
  }
  keep(next, events.length);
  return { events: scrubbed, indexOf };
}

/**
 * The events of the clicks whose next typed value is secret: protected input, or one of
 * `alsoSecret` (placeholders the teacher chose Hidden for). What such a click hit is never kept:
 * no picture, no label, no window.
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
/** A click step that quotes what it hit, as `describeClick` writes it. */
const QUOTED_CLICK = /" \(near -?\d+, -?\d+\)\.$/;

/** Model or window text made safe to quote in a step: one line, no input braces or quotes. */
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

/** Set on a recording once what was typed in it is forgotten, so it is never done twice. */
const FORGOTTEN = "dozoScrubbed";

/** Whether a stored recording already had what was typed in it forgotten. */
export function teachTypingForgotten(recording: unknown): boolean {
  return (
    typeof recording === "object" &&
    recording !== null &&
    "dozoScrubbed" in recording &&
    recording.dozoScrubbed === true
  );
}

/**
 * A recording with what was typed and opened in it forgotten: each typed run is one event (as
 * `scrubTeachEvents`), every window title keeps only its application's name (a snapshot whose
 * title names none is dropped, its event kept without a title so the steps stay the same), and
 * cached value suggestions go. Marked, so a recording already forgotten is left as it is: its
 * titles are already application names, which would not survive a second pass.
 */
export function forgetTeachTyping<
  R extends { events: TeachRecordingEvent[]; snapshots: TeachSnapshot[] },
>(recording: R, forgotten = teachTypingForgotten(recording)) {
  const { dozoSuggestions: _cached, ...kept } = recording as R & { dozoSuggestions?: unknown };
  if (forgotten) return { ...kept, [FORGOTTEN]: true as const };
  const events = scrubTeachEvents(recording.events).map((event) => {
    if (event.kind !== "snapshot" || event.summary === undefined) return event;
    const { summary, ...rest } = event;
    const app = teachAppName(summary);
    return app ? { ...rest, summary: app } : rest;
  });
  const snapshots = recording.snapshots.flatMap((snapshot) => {
    const app = teachAppName(snapshot.summary);
    return app ? [{ ...snapshot, summary: app }] : [];
  });
  return { ...kept, events, snapshots, [FORGOTTEN]: true as const };
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

/** The name an input is listed under, without the secret mark. */
function inputName(input: string): string {
  return input.endsWith(SECRET_MARK) ? input.slice(0, -SECRET_MARK.length) : input;
}

/** The stable code of a save or test that gives two different values one name. */
export const TEACH_NAME_TAKEN = "teach_name_taken";

/** Whether two values are one: the same text, known for both. */
function sameValue(a: TeachTypedValue, b: TeachTypedValue): boolean {
  return a.text !== null && a.text === b.text && a.secret === b.secret;
}

/**
 * Applies the teacher's decision to each typed value: an input the bot fills on each run (hidden
 * ones typed from a saved login, never asked for in chat), text kept in the steps, or the steps
 * that type it removed. A value with no decision is an input named `value_N`. A protected value
 * stays secret whatever is chosen, and one without text is never kept as text. Values the steps
 * no longer hold are left alone. Two values share a name only when they are the same text;
 * otherwise the save is refused (`TEACH_NAME_TAKEN`) rather than merging them. The inputs already
 * listed (the goal, ones added by hand) stay, without the draft's `value N` labels; a named input
 * follows unless one of that name is already listed, which it then marks secret if it is.
 */
export function applyValueDecisions(
  playbook: SkillPlaybook,
  values: TeachTypedValue[],
  decisions: Record<string, TeachValueDecision | undefined>,
): SkillPlaybook {
  let steps = [...playbook.steps];
  const variables = new Map<string, { value: TeachTypedValue; secret: boolean }>();
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
        throw new ClientError("BAD_REQUEST", "This value cannot be kept in the skill");
      }
      const text = JSON.stringify(value.text);
      steps = steps.map((step) => step.replaceAll(value.placeholder, text));
      return;
    }
    const name = teachInputName(decision.name) || `value_${index + 1}`;
    const secret = value.secret || decision.action === "hidden";
    const named = variables.get(name);
    if (named && !sameValue(named.value, value)) {
      throw new ClientError("BAD_REQUEST", "Each name can be used once.", TEACH_NAME_TAKEN);
    }
    variables.set(name, { value, secret: (named?.secret ?? false) || secret });
    steps = steps.map((step) => step.replaceAll(value.placeholder, `{{${name}}}`));
  });
  const kept = playbook.inputs
    .filter((input) => !PLACEHOLDER_LABEL.test(input))
    .map((input) => {
      const name = inputName(input);
      return variables.get(name)?.secret ? inputLabel(name, true) : input;
    });
  const listed = new Set(kept.map(inputName));
  const added = [...variables]
    .filter(([name]) => !listed.has(name))
    .map(([name, { secret }]) => inputLabel(name, secret));
  return { ...playbook, inputs: [...kept, ...added], steps: steps.length ? steps : [DEFAULT_STEP] };
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
  const prompt = [
    upstreamFormatSkillRunPrompt(name, playbook, test),
    playbook.steps.some((step) => QUOTED_CLICK.test(step)) ? SKILL_CLICK_TARGETS_NOTE : "",
  ]
    .filter(Boolean)
    .join("\n");
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
