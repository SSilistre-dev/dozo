import { refNode } from "./dozo-device-browser.js";

/**
 * Form submits of the page tools, counted as sends (dozo-send-limit.ts). What counts, the same in the
 * bot's own computer and in the user's browser: a press of a submit control (a button without a type or
 * of type submit, an input of type submit or image, also one named by a `form` attribute) in a form that is
 * not a search, and, in the user's browser, a line break typed into a one-line field of such a form. A
 * search is a form read with GET that says so (`role=search`, or a `type=search` field in it); a
 * `method=dialog` form sends nothing. A control that only runs a script (a `type=button`, a link, a
 * `role=button`) is not a submit: a page that sends from one cannot be told from a click, which stays the
 * limit of this count. A press the browser could not look at (a control in a frame, an element it could
 * not find) counts as a submit, so a miss leans to the cautious side.
 */

/** What the bot's own computer found for a browser_act call, kept by the call's list of actions. */
const found = new WeakMap<object, number>();

/** What the bot's own computer's page browser said about a browser_act call's clicks, if it did. */
export function notedPageSubmits(actions: object): number | undefined {
  return found.get(actions);
}

/** Remembers how many submits the page browser found in a browser_act call's clicks, before they run. */
export function dozoNotePageSubmits(
  name: string,
  args: Record<string, unknown>,
  submits: number | undefined,
): void {
  if (name === "browser_act" && Array.isArray(args.actions) && submits !== undefined)
    found.set(args.actions, submits);
}

/** A node of the user's browser page, as its DOM commands answer it. */
export interface DomNode {
  backendNodeId?: number;
  nodeName?: string;
  /** Name, value, name, value. */
  attributes?: string[];
  children?: DomNode[];
  contentDocument?: DomNode;
  shadowRoots?: DomNode[];
}

export type Step = { kind: string; ref?: string; text?: string };

const MAX_NODES = 200_000;
const LINE_BREAK = /[\r\n]/;
const SINGLE_LINE_FIELD = new Set([
  "",
  "text",
  "email",
  "password",
  "search",
  "tel",
  "url",
  "number",
]);

const attribute = (node: DomNode, name: string): string | undefined => {
  const list = node.attributes ?? [];
  for (let at = 0; at + 1 < list.length; at += 2)
    if (list[at]?.toLowerCase() === name) return list[at + 1] ?? "";
  return undefined;
};
const tag = (node: DomNode) => (node.nodeName ?? "").toUpperCase();

/** The steps of a call that could send: clicks, and text with a line break. */
export function sendingSteps(actions: unknown[]): Step[] {
  return actions.flatMap((raw) => {
    const step = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const kind = String(step.kind ?? "");
    const text = typeof step.text === "string" ? step.text : "";
    if (kind === "click" || (kind === "type" && LINE_BREAK.test(text)))
      return [{ kind, ref: step.ref === undefined ? undefined : String(step.ref).trim(), text }];
    return [];
  });
}

/**
 * How many of these steps submit a form, from the page's DOM. A step whose element is not in it counts
 * as one.
 */
export function submitsIn(root: DomNode | undefined, steps: Step[]): number {
  if (!root) return steps.length;
  const parents = new Map<DomNode, DomNode>();
  const byBackend = new Map<number, DomNode>();
  const byId = new Map<string, DomNode>();
  const pending = [root];
  for (let seen = 0; pending.length && seen < MAX_NODES; seen += 1) {
    const node = pending.pop()!;
    if (node.backendNodeId !== undefined) byBackend.set(node.backendNodeId, node);
    const id = attribute(node, "id");
    if (id !== undefined && !byId.has(id)) byId.set(id, node);
    for (const child of [
      ...(node.children ?? []),
      ...(node.shadowRoots ?? []),
      ...(node.contentDocument ? [node.contentDocument] : []),
    ]) {
      parents.set(child, node);
      pending.push(child);
    }
  }
  const ancestors = function* (node: DomNode) {
    for (let at = parents.get(node); at; at = parents.get(at)) yield at;
  };
  const formOf = (node: DomNode): DomNode | undefined => {
    const named = attribute(node, "form");
    if (named !== undefined) {
      const form = byId.get(named);
      return form && tag(form) === "FORM" ? form : undefined;
    }
    for (const above of ancestors(node)) if (tag(above) === "FORM") return above;
    return undefined;
  };
  const hasSearchField = (form: DomNode): boolean => {
    const stack = [...(form.children ?? [])];
    for (let seen = 0; stack.length && seen < MAX_NODES; seen += 1) {
      const node = stack.pop()!;
      if (tag(node) === "INPUT" && attribute(node, "type")?.toLowerCase() === "search") return true;
      stack.push(...(node.children ?? []));
    }
    return false;
  };
  const isSearch = (form: DomNode) =>
    attribute(form, "role")?.toLowerCase() === "search" ||
    [...ancestors(form)].some((above) => attribute(above, "role")?.toLowerCase() === "search") ||
    hasSearchField(form);
  const sends = (form: DomNode, control?: DomNode) => {
    const method = (
      (control && attribute(control, "formmethod")) ||
      attribute(form, "method") ||
      "get"
    ).toLowerCase();
    return method !== "dialog" && (method !== "get" || !isSearch(form));
  };
  const submitControl = (node: DomNode) => {
    if (attribute(node, "disabled") !== undefined) return false;
    const type = attribute(node, "type")?.toLowerCase();
    if (tag(node) === "BUTTON") return type !== "button" && type !== "reset";
    return tag(node) === "INPUT" && (type === "submit" || type === "image");
  };
  let total = 0;
  for (const step of steps) {
    const backend = refNode(step.ref);
    const node = backend === undefined ? undefined : byBackend.get(backend);
    if (!node) {
      total += 1;
    } else if (step.kind === "click") {
      const form = submitControl(node) ? formOf(node) : undefined;
      total += form && sends(form, node) ? 1 : 0;
    } else {
      // A line break in a one-line field submits its form; in a text area it breaks the line.
      const form =
        tag(node) === "INPUT" && SINGLE_LINE_FIELD.has(attribute(node, "type")?.toLowerCase() ?? "")
          ? formOf(node)
          : undefined;
      total += form && sends(form) ? 1 : 0;
    }
  }
  return total;
}
