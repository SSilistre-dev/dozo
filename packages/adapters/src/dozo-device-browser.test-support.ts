import type { DeviceBrowserEvent, DeviceBrowserSend } from "./dozo-device-browser.js";

/** A page as the browser's accessibility tree has it: names already computed, as Chrome does. */
export interface DevicePage {
  title: string;
  /** `opens`: a click on it goes to that page. */
  nodes: Array<{
    role: string;
    name: string;
    value?: string;
    checked?: boolean;
    opens?: string;
    /** The element in the page's DOM (`DOM.getDocument`): its tag, attributes and the form it sits in. */
    tag?: string;
    attrs?: Record<string, string>;
    form?: string;
  }>;
  /** The forms of the DOM, by the key a node names, with their attributes. */
  forms?: Record<string, Record<string, string>>;
  /** A dialog the page opens once loaded. */
  dialog?: { type: "alert" | "confirm"; message: string };
}

/** The page browser-conformance.test.ts seeds, as Chrome reads it. */
export const seededDevicePages: Record<string, DevicePage> = {
  "https://example.test/form": {
    title: "Signup",
    nodes: [
      { role: "StaticText", name: "Email" },
      { role: "textbox", name: "Email" },
      { role: "button", name: "Continue" },
      { role: "button", name: "with team Share" },
      { role: "button", name: "Fallback" },
      { role: "button", name: "Whitespace fallback" },
      { role: "button", name: "Empty fallback" },
    ],
  },
};

const FIRST_NODE = 10;
const ROW = 40;

/**
 * A stand-in for the desktop app and its browser: answers the DevTools commands the provider
 * sends, from `pages`. Node `i` sits in row `i` of the screen; a click lands on the row's node.
 */
export function fakeDeviceBrowser(pages: Record<string, DevicePage>) {
  let url = "about:blank";
  const values = new Map<number, string>();
  let focused: number | undefined;
  let selected = false;
  let events: DeviceBrowserEvent[] = [];
  const commands: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const page = () => pages[url];
  const node = (id: number) => page()?.nodes[id - FIRST_NODE];
  const defaultTag = (role: string) =>
    role === "button" ? "BUTTON" : role === "link" ? "A" : role === "textbox" ? "INPUT" : "DIV";

  const answer = (method: string, params: Record<string, unknown>): unknown => {
    switch (method) {
      case "Page.navigate": {
        const target = String(params.url);
        if (!pages[target]) return { errorText: "net::ERR_NAME_NOT_RESOLVED" };
        url = target;
        values.clear();
        events.push({ method: "Page.loadEventFired", params: {} });
        const dialog = pages[target]!.dialog;
        if (dialog) events.push({ method: "Page.javascriptDialogOpening", params: { ...dialog } });
        return { frameId: "main" };
      }
      case "Page.getNavigationHistory":
        return { currentIndex: 0, entries: [{ id: 1, url, title: page()?.title ?? "" }] };
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "root",
              role: { value: "RootWebArea" },
              name: { value: page()?.title ?? "" },
              childIds: (page()?.nodes ?? []).map((_, index) => String(FIRST_NODE + index)),
            },
            ...(page()?.nodes ?? []).map((entry, index) => ({
              nodeId: String(FIRST_NODE + index),
              role: { value: entry.role },
              name: { value: entry.name },
              backendDOMNodeId: FIRST_NODE + index,
              ...(values.has(FIRST_NODE + index) || entry.value
                ? { value: { value: values.get(FIRST_NODE + index) ?? entry.value } }
                : {}),
              ...(entry.checked
                ? { properties: [{ name: "checked", value: { value: true } }] }
                : {}),
            })),
          ],
        };
      case "DOM.describeNode": {
        const entry = node(Number(params.backendNodeId));
        if (!entry) throw new Error("The bot's browser refused DOM.describeNode: no such node");
        return {
          node: {
            backendNodeId: Number(params.backendNodeId),
            nodeName: entry.tag ?? defaultTag(entry.role),
            attributes: Object.entries(entry.attrs ?? {}).flat(),
          },
        };
      }
      case "DOM.getDocument": {
        const flat = (attrs: Record<string, string> = {}) => Object.entries(attrs).flat();
        const entries = (page()?.nodes ?? []).map((entry, index) => ({
          form: entry.form,
          element: {
            backendNodeId: FIRST_NODE + index,
            nodeName: entry.tag ?? defaultTag(entry.role),
            attributes: flat(entry.attrs),
          },
        }));
        const forms = Object.entries(page()?.forms ?? {}).map(([key, attrs], at) => ({
          backendNodeId: 1000 + at,
          nodeName: "FORM",
          attributes: flat(attrs),
          children: entries.filter((entry) => entry.form === key).map((entry) => entry.element),
        }));
        return {
          root: {
            backendNodeId: 1,
            nodeName: "#document",
            children: [
              {
                backendNodeId: 2,
                nodeName: "BODY",
                children: [
                  ...entries.filter((entry) => !entry.form).map((entry) => entry.element),
                  ...forms,
                ],
              },
            ],
          },
        };
      }
      case "DOM.scrollIntoViewIfNeeded":
        return {};
      case "DOM.getBoxModel": {
        const id = Number(params.backendNodeId);
        if (!node(id))
          throw new Error("The bot's browser refused DOM.getBoxModel: No node with given id");
        const top = (id - FIRST_NODE) * ROW;
        return { model: { border: [0, top, 100, top, 100, top + 30, 0, top + 30] } };
      }
      case "Input.dispatchMouseEvent": {
        if (params.type !== "mousePressed") return {};
        const id = FIRST_NODE + Math.floor(Number(params.y) / ROW);
        const opens = node(id)?.opens;
        focused = node(id) ? id : undefined;
        selected = Number(params.clickCount) >= 3;
        if (opens) {
          url = opens;
          values.clear();
          events.push({ method: "Page.loadEventFired", params: {} });
        }
        return {};
      }
      case "Input.insertText":
        if (focused !== undefined)
          values.set(
            focused,
            `${selected ? "" : (values.get(focused) ?? "")}${String(params.text)}`,
          );
        selected = false;
        return {};
      case "Input.dispatchKeyEvent": {
        if (focused === undefined) return {};
        if (params.key === "Backspace" && params.type === "rawKeyDown") values.set(focused, "");
        else if (params.type === "keyDown" && typeof params.text === "string")
          values.set(focused, `${selected ? "" : (values.get(focused) ?? "")}${params.text}`);
        if (params.type === "keyDown" || params.type === "rawKeyDown") selected = false;
        return {};
      }
      case "Page.handleJavaScriptDialog":
        return {};
      case "Page.captureScreenshot":
        return { data: "c2NyZWVu" };
      default:
        throw new Error(`Not allowed in the bot's browser: ${method}`);
    }
  };

  const send: DeviceBrowserSend = async (command) => {
    commands.push(command);
    const result = answer(command.method, command.params ?? {});
    const sent = events;
    events = [];
    return { result, events: sent };
  };
  return Object.assign(send, {
    commands,
    value: (id: number) => values.get(id),
  });
}
