import type {
  AdapterContext,
  BrowserActRequest,
  BrowserActResult,
  BrowserNavigateRequest,
  BrowserNavigateResult,
  BrowserProvider,
  BrowserSnapshotNode,
  BrowserSnapshotRequest,
  BrowserSnapshotResult,
  ComputerRef,
} from "@rakazo/adapter-kit";
import { abortableDelay } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";

/**
 * The bot's own browser on the user's computer, driven from here: the desktop app passes each
 * DevTools command on to the bot's page through its allowlist (`dozo/desktop/src/browser.rs`) and
 * answers with the result and the page events since the last answer. Everything the bot sees is
 * built here from the page's accessibility tree; no script runs in the page and no cookie or
 * storage is read. Refs are the page's own node ids (`e<backendNodeId>`), stable while the
 * element lives.
 */
export interface DeviceBrowserEvent {
  method: string;
  params?: Record<string, unknown>;
}
export type DeviceBrowserSend = (command: {
  method: string;
  params?: Record<string, unknown>;
}) => Promise<{ result?: unknown; events?: DeviceBrowserEvent[] }>;

interface AXValue {
  value?: unknown;
}
interface AXNode {
  nodeId: string;
  ignored?: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: Array<{ name: string; value?: AXValue }>;
  childIds?: string[];
  backendDOMNodeId?: number;
}

const INTERACTIVE = new Set([
  "button",
  "link",
  "textbox",
  "searchbox",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "tab",
  "option",
  "slider",
  "spinbutton",
  "listbox",
  "treeitem",
]);
const MAX_LINES = 800;
const MAX_TREE = 30_000;
const MAX_NAME = 200;
const LOAD_WAIT_MS = 10_000;
const POLL_MS = 200;
const SETTLE_MS = 300;
export const MOVED_SITE =
  "The page moved to another site, so the rest was not done. Check the page and ask again.";
export const UNSUPPORTED_STEP =
  "This step is not available in the bot's browser on the user's computer yet.";

const text = (value: unknown) =>
  (typeof value === "string" ? value : value == null ? "" : String(value))
    .replaceAll(/\s+/g, " ")
    .trim()
    .slice(0, MAX_NAME);

/** Waits, and throws once the call was aborted. */
async function delay(ms: number, signal?: AbortSignal) {
  await abortableDelay(ms, signal);
  signal?.throwIfAborted();
}

/** A page's registrable domain, or "" when it has none. */
function siteOf(url: string): string {
  return URL.canParse(url) ? (hostSite(new URL(url).hostname) ?? "") : "";
}

/** The page node an element ref names, or undefined for one this browser never gave. */
export function refNode(ref: string | undefined): number | undefined {
  const match = /^e(\d{1,12})$/.exec(ref ?? "");
  return match ? Number(match[1]) : undefined;
}

/** The page's accessibility tree as the bot reads it: controls with refs, headings and text. */
export function readAccessibilityTree(
  nodes: AXNode[],
  query?: string,
): { tree: string; elements: BrowserSnapshotNode[] } {
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const parents = new Map<string, string>();
  for (const node of nodes)
    for (const child of node.childIds ?? []) parents.set(child, node.nodeId);
  const role = (node: AXNode) => text(node.role?.value);
  // Text inside a control or heading is already its name.
  const labelled = (node: AXNode) => {
    for (let id = parents.get(node.nodeId); id; id = parents.get(id)) {
      const parent = byId.get(id);
      if (
        parent &&
        !parent.ignored &&
        (INTERACTIVE.has(role(parent)) || role(parent) === "heading")
      )
        return true;
    }
    return false;
  };
  const words = (query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (line: string) =>
    !words.length || words.some((word) => line.toLowerCase().includes(word));
  const elements: BrowserSnapshotNode[] = [];
  const lines: string[] = [];
  for (const node of nodes) {
    if (node.ignored) continue;
    const kind = role(node);
    const name = text(node.name?.value);
    let line: string | undefined;
    if (INTERACTIVE.has(kind) && node.backendDOMNodeId !== undefined) {
      const ref = `e${node.backendDOMNodeId}`;
      const value = text(node.value?.value);
      const state = (node.properties ?? [])
        .filter(
          (property) =>
            ["checked", "disabled", "expanded", "selected"].includes(property.name) &&
            property.value?.value === true,
        )
        .map((property) => ` ${property.name}`)
        .join("");
      line = `- ${kind} ${JSON.stringify(name)} [${ref}]${value ? ` value=${JSON.stringify(value)}` : ""}${state}`;
      if (!matches(line)) continue;
      elements.push({ ref, role: kind, name, ...(value ? { value } : {}) });
    } else if (kind === "heading" && name) {
      line = `- heading ${JSON.stringify(name)}`;
    } else if (kind === "StaticText" && name && !labelled(node)) {
      line = `- text ${JSON.stringify(name)}`;
    }
    if (line && matches(line)) lines.push(line);
  }
  let tree = lines.length ? "" : "(no interactive elements)";
  let shown = 0;
  for (const line of lines) {
    if (shown === MAX_LINES || tree.length + line.length > MAX_TREE) {
      tree += "\n- (the page goes on: use browser_snapshot with a query to find more)";
      break;
    }
    tree += `${shown ? "\n" : ""}${line}`;
    shown += 1;
  }
  return { tree, elements };
}

export class DeviceBrowserProvider implements BrowserProvider {
  private loads = 0;
  /** The site the next batch was approved for, when the caller knows it. */
  expectedSite: string | undefined;
  private dialog: string | undefined;
  private notes: string[] = [];

  constructor(private readonly sendCommand: DeviceBrowserSend) {}

  describe() {
    return {
      id: "device",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { page: true, refs: true, keyless: true },
    };
  }

  /** One command, its events noted: loads, and dialogs (an alert is closed and reported). */
  private async send(method: string, params?: Record<string, unknown>) {
    const answer = await this.sendCommand({ method, ...(params ? { params } : {}) });
    for (const event of answer.events ?? []) await this.observe(event);
    return (answer.result ?? {}) as Record<string, unknown>;
  }

  private async observe(event: DeviceBrowserEvent) {
    if (event.method === "Page.loadEventFired") this.loads += 1;
    if (event.method === "Page.javascriptDialogClosed") this.dialog = undefined;
    if (event.method !== "Page.javascriptDialogOpening") return;
    const message = text(event.params?.message);
    if (event.params?.type === "alert") {
      await this.sendCommand({ method: "Page.handleJavaScriptDialog", params: { accept: true } });
      this.notes.push(`The page showed an alert, which was closed: ${JSON.stringify(message)}`);
    } else {
      this.dialog = message || "The page has a dialog open.";
    }
  }

  private pageNotice() {
    const note = this.notes.splice(0).join(" ");
    return { ...(note ? { note } : {}), ...(this.dialog ? { dialog: this.dialog } : {}) };
  }

  private async where(): Promise<{ url: string; title: string }> {
    const history = await this.send("Page.getNavigationHistory");
    const entries = Array.isArray(history.entries) ? history.entries : [];
    const current = entries[Number(history.currentIndex)] as
      | { url?: unknown; title?: unknown }
      | undefined;
    return { url: text(current?.url ?? ""), title: text(current?.title ?? "") };
  }

  /** Waits for a page load after `since` loads, asking cheaply; false when it did not come. */
  private async loaded(since: number, signal?: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + LOAD_WAIT_MS;
    while (this.loads <= since && !this.dialog && Date.now() < deadline) {
      await delay(POLL_MS, signal);
      await this.send("Page.getNavigationHistory");
    }
    return this.loads > since;
  }

  private async page(query?: string) {
    const where = await this.where();
    if (this.dialog) return { ...where, tree: "", elements: [] };
    const result = await this.send("Accessibility.getFullAXTree");
    const nodes = Array.isArray(result.nodes) ? (result.nodes as AXNode[]) : [];
    return { ...where, ...readAccessibilityTree(nodes, query) };
  }

  async navigate(
    _computer: ComputerRef,
    request: BrowserNavigateRequest,
    context: AdapterContext,
  ): Promise<BrowserNavigateResult> {
    const since = this.loads;
    const result = await this.send("Page.navigate", { url: request.url });
    if (typeof result.errorText === "string" && result.errorText) {
      return {
        url: request.url,
        title: "",
        error: `The page did not load: ${result.errorText}`,
        ...this.pageNotice(),
      };
    }
    const loaded = await this.loaded(since, context.signal);
    const page = await this.page();
    return { ...page, ...(loaded ? {} : { loading: true }), ...this.pageNotice() };
  }

  async snapshot(
    _computer: ComputerRef,
    request: BrowserSnapshotRequest,
    _context: AdapterContext,
  ): Promise<BrowserSnapshotResult> {
    const page = await this.page(request.query);
    return { ...page, ...this.pageNotice() };
  }

  /** The middle of an element on the screen, scrolled into view first. */
  private async center(node: number): Promise<{ x: number; y: number }> {
    await this.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: node }).catch(() => undefined);
    const box = await this.send("DOM.getBoxModel", { backendNodeId: node });
    const quad = (box.model as { border?: number[] } | undefined)?.border ?? [];
    if (quad.length < 8) throw new Error("The element is not on the page.");
    return {
      x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
      y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
    };
  }

  private async click(at: { x: number; y: number }, clickCount: number) {
    await this.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: at.x, y: at.y });
    for (const type of ["mousePressed", "mouseReleased"])
      await this.send("Input.dispatchMouseEvent", {
        type,
        x: at.x,
        y: at.y,
        button: "left",
        clickCount,
      });
  }

  async act(
    _computer: ComputerRef,
    request: BrowserActRequest,
    context: AdapterContext,
  ): Promise<BrowserActResult> {
    let completed = 0;
    let touched = false;
    // The batch acts on the site it was approved for: a step that would act on another (an earlier
    // click went there) stops it, so the next call is asked about the new site.
    const site = siteOf((await this.where()).url);
    const stop = async (error: string, uncertain: boolean): Promise<BrowserActResult> => {
      const page = await this.page().catch(() => ({ url: "", title: "" }));
      return { ok: false, completed, uncertain, ...page, error, ...this.pageNotice() };
    };
    // The page is another site's than the one approved (another thread's run moved it).
    if (this.expectedSite !== undefined && site !== this.expectedSite)
      return stop(MOVED_SITE, false);
    for (const step of request.actions) {
      context.signal.throwIfAborted();
      if (completed > 0 && siteOf((await this.where()).url) !== site)
        return stop(MOVED_SITE, false);
      const node = refNode(step.ref);
      if (step.kind !== "click" && step.kind !== "fill" && step.kind !== "type")
        return stop(UNSUPPORTED_STEP, false);
      if (node === undefined) return stop(`Unknown element ref ${String(step.ref)}.`, false);
      if (step.kind !== "click" && step.origin) {
        const { url } = await this.where();
        if (!URL.canParse(url) || new URL(url).origin !== step.origin)
          return stop("The page is not on the site this text is for.", false);
      }
      let at: { x: number; y: number };
      try {
        at = await this.center(node);
      } catch (error) {
        return stop(error instanceof Error ? error.message : String(error), false);
      }
      try {
        touched = true;
        if (step.kind === "click") {
          await this.click(at, 1);
        } else {
          // Three clicks select a field's text, which what is typed then replaces.
          await this.click(at, 3);
          if (step.kind === "fill" && step.text) {
            await this.send("Input.insertText", { text: step.text });
          } else if (step.kind === "fill") {
            await this.key("Backspace", 8);
          } else {
            for (const character of step.text) {
              await this.send("Input.dispatchKeyEvent", {
                type: "keyDown",
                key: character,
                text: character,
              });
              await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
            }
          }
        }
      } catch (error) {
        return stop(error instanceof Error ? error.message : String(error), touched);
      }
      completed += 1;
    }
    // A click that starts a navigation gets a moment to show the next page.
    await delay(SETTLE_MS, context.signal);
    const page = await this.page();
    return { ok: true, completed, ...page, ...this.pageNotice() };
  }

  private async key(key: string, code: number) {
    await this.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key,
      windowsVirtualKeyCode: code,
    });
    await this.send("Input.dispatchKeyEvent", { type: "keyUp", key, windowsVirtualKeyCode: code });
  }

  /** The visible page as a JPEG, base64, for a model that can see. */
  async screenshot(): Promise<string | undefined> {
    const shot = await this.send("Page.captureScreenshot", { format: "jpeg", quality: 60 });
    return typeof shot.data === "string" ? shot.data : undefined;
  }
}
