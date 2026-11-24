import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  DEVICE_FILL_FAILED,
  DeviceBrowserProvider,
  MOVED_SITE,
  PictureRefusedError,
  readAccessibilityTree,
  refNode,
  UNSUPPORTED_STEP,
} from "./dozo-device-browser.js";
import type { DevicePage } from "./dozo-device-browser.test-support.js";
import { fakeDeviceBrowser, seededDevicePages } from "./dozo-device-browser.test-support.js";

const computer: ComputerRef = { id: "d", botId: "b", kind: "user-device", providerRef: "d" };
const context = () =>
  ({
    operationId: "1",
    traceId: "1",
    spaceId: "s",
    userId: "u",
    signal: new AbortController().signal,
  }) as AdapterContext;
const FORM = "https://example.test/form";

function setup(pages: Record<string, DevicePage> = seededDevicePages) {
  const device = fakeDeviceBrowser(pages);
  return { device, provider: new DeviceBrowserProvider(device) };
}

describe("the browser on the user's computer", () => {
  it("says it drives a page by refs, with no hosted browser", () => {
    expect(setup().provider.describe()).toMatchObject({
      id: "device",
      contractVersion: "1",
      capabilities: { page: true, refs: true, keyless: true },
    });
  });

  it("navigates, waits for the load and reads the page", async () => {
    const { provider, device } = setup();
    const page = await provider.navigate(computer, { url: FORM }, context());
    expect(page).toMatchObject({ url: FORM, title: "Signup" });
    expect(page.loading).toBeUndefined();
    expect(page.tree).toContain('- textbox "Email" [e11]');
    expect(page.tree).toContain('- text "Email"');
    expect(page.elements?.map((element) => element.ref)).toContain("e12");
    // Only page commands, never script, cookies or storage.
    expect(new Set(device.commands.map((command) => command.method.split(".")[0]))).toEqual(
      new Set(["Page", "Accessibility"]),
    );
  });

  it("says when a page does not load", async () => {
    const { provider } = setup();
    const page = await provider.navigate(computer, { url: "https://nowhere.test/" }, context());
    expect(page.error).toBe("The page did not load: net::ERR_NAME_NOT_RESOLVED");
  });

  it("fills, types and clicks by ref, and shows the page after", async () => {
    const { provider, device } = setup();
    await provider.navigate(computer, { url: FORM }, context());
    const filled = await provider.act(
      computer,
      {
        actions: [
          { kind: "fill", ref: "e11", text: "ada@example.test" },
          { kind: "click", ref: "e12" },
        ],
      },
      context(),
    );
    expect(filled).toMatchObject({ ok: true, completed: 2, url: FORM });
    expect(device.value(11)).toBe("ada@example.test");
    expect(filled.tree).toContain('value="ada@example.test"');
    await provider.act(
      computer,
      { actions: [{ kind: "type", ref: "e11", text: "ok" }] },
      context(),
    );
    expect(device.value(11)).toBe("ok");
    await provider.act(computer, { actions: [{ kind: "fill", ref: "e11", text: "" }] }, context());
    expect(device.value(11)).toBe("");
  });

  it("refuses what it cannot do before touching the page", async () => {
    const { provider, device } = setup();
    await provider.navigate(computer, { url: FORM }, context());
    const before = device.commands.length;
    const upload = await provider.act(
      computer,
      { actions: [{ kind: "upload", ref: "e11", paths: ["/etc/passwd"] }] },
      context(),
    );
    expect(upload).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
      error: UNSUPPORTED_STEP,
    });
    const unknown = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "x1" }] },
      context(),
    );
    expect(unknown.error).toBe("Unknown element ref x1.");
    const elsewhere = await provider.act(
      computer,
      { actions: [{ kind: "fill", ref: "e11", text: "a", origin: "https://other.test" }] },
      context(),
    );
    expect(elsewhere.error).toBe("The page is not on the site this text is for.");
    const gone = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e99" }] },
      context(),
    );
    expect(gone).toMatchObject({ ok: false, uncertain: false });
    expect(gone.error).toContain("No node with given id");
    const sent = device.commands.slice(before).map((command) => command.method);
    expect(sent).not.toContain("Input.dispatchMouseEvent");
    expect(sent).not.toContain("Input.insertText");
  });

  it("closes an alert and says so, and reports a dialog that asks", async () => {
    const { provider } = setup({
      "https://a.test/": { title: "A", nodes: [], dialog: { type: "alert", message: "Saved" } },
      "https://c.test/": { title: "C", nodes: [], dialog: { type: "confirm", message: "Leave?" } },
    });
    const alerted = await provider.navigate(computer, { url: "https://a.test/" }, context());
    expect(alerted.note).toBe('The page showed an alert, which was closed: "Saved"');
    expect(alerted.dialog).toBeUndefined();
    const asked = await provider.navigate(computer, { url: "https://c.test/" }, context());
    expect(asked).toMatchObject({ dialog: "Leave?", tree: "" });
  });

  it("gives nothing of a page that went to another site while it was read", async () => {
    const pages = {
      ...seededDevicePages,
      "https://other.test/": { title: "Other", nodes: [{ role: "button", name: "Secret" }] },
    };
    const device = fakeDeviceBrowser(pages);
    const away = { method: "Page.navigate", params: { url: "https://other.test/" } };
    let moveOn = "";
    const provider = new DeviceBrowserProvider(async (command) => {
      if (command.method === moveOn) await device(away);
      return device(command);
    });
    await provider.navigate(computer, { url: FORM }, context());
    moveOn = "Accessibility.getFullAXTree";
    const read = await provider.snapshot(computer, {}, context());
    expect(read).toMatchObject({ url: "https://other.test/", tree: "", elements: [] });
    await provider.navigate(computer, { url: FORM }, context());
    moveOn = "Page.captureScreenshot";
    expect(await provider.screenshot("example.test")).toBeUndefined();
    await provider.navigate(computer, { url: FORM }, context());
    moveOn = "";
    expect(await provider.screenshot("example.test")).toBe("c2NyZWVu");
  });

  it("says so when the computer refuses a picture of a page it filled a password into", async () => {
    const provider = new DeviceBrowserProvider(async (command) => {
      if (command.method === "Page.captureScreenshot") throw new Error("passwords-screenshot");
      return { result: {} };
    });
    await expect(provider.screenshot()).rejects.toBeInstanceOf(PictureRefusedError);
  });

  it("takes a screenshot of the visible page", async () => {
    const { provider, device } = setup();
    expect(await provider.screenshot()).toBe("c2NyZWVu");
    expect(device.commands.at(-1)).toEqual({
      method: "Page.captureScreenshot",
      params: { format: "jpeg", quality: 60 },
    });
  });
});

describe("a batch of steps", () => {
  it("stops when a step took the page to another site, before acting there", async () => {
    const { provider, device } = setup({
      "https://a.test/": {
        title: "A",
        nodes: [
          { role: "link", name: "Elsewhere", opens: "https://b.test/" },
          { role: "button", name: "Stay" },
        ],
      },
      "https://b.test/": { title: "B", nodes: [{ role: "textbox", name: "Card" }] },
    });
    await provider.navigate(computer, { url: "https://a.test/" }, context());
    const acted = await provider.act(
      computer,
      {
        actions: [
          { kind: "click", ref: "e10" },
          { kind: "fill", ref: "e10", text: "4242" },
        ],
      },
      context(),
    );
    expect(acted).toMatchObject({ ok: false, completed: 1, uncertain: false, error: MOVED_SITE });
    expect(device.value(10)).toBeUndefined();
  });
});

describe("waiting and failing", () => {
  it("asks again until the page has loaded", async () => {
    const device = fakeDeviceBrowser(seededDevicePages);
    let asked = 0;
    // The load comes with the second look rather than with the navigation.
    const late = async (command: { method: string; params?: Record<string, unknown> }) => {
      const answer = await device(command);
      if (command.method === "Page.getNavigationHistory") asked += 1;
      const events = (answer.events ?? []).filter(
        (event) => event.method !== "Page.loadEventFired",
      );
      if (asked === 2) events.push({ method: "Page.loadEventFired", params: {} });
      return { ...answer, events };
    };
    const page = await new DeviceBrowserProvider(late).navigate(computer, { url: FORM }, context());
    expect(page.loading).toBeUndefined();
    expect(asked).toBeGreaterThanOrEqual(2);
  });

  it("is uncertain when a step fails after it touched the page", async () => {
    const device = fakeDeviceBrowser(seededDevicePages);
    const flaky = async (command: { method: string; params?: Record<string, unknown> }) => {
      if (command.method === "Input.dispatchMouseEvent") throw "connection lost";
      return device(command);
    };
    const provider = new DeviceBrowserProvider(flaky);
    await provider.navigate(computer, { url: FORM }, context());
    const acted = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e12" }] },
      context(),
    );
    expect(acted).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: true,
      error: "connection lost",
    });
  });
});

describe("answers it does not expect", () => {
  it("reads them as nothing rather than failing", async () => {
    let dialog = true;
    const odd = async (command: { method: string }) => {
      switch (command.method) {
        case "Page.navigate":
          // A dialog opens before any load, with no message.
          return {
            events: [{ method: "Page.javascriptDialogOpening", params: { type: "confirm" } }],
          };
        case "Page.getNavigationHistory":
          return dialog
            ? { result: { entries: "none" } }
            : { result: { currentIndex: 0, entries: [{ url: 42, title: null }] } };
        case "Accessibility.getFullAXTree":
          return { result: { nodes: null } };
        case "DOM.getBoxModel":
          return { result: { model: {} } };
        case "Page.handleJavaScriptDialog":
          dialog = false;
          return { events: [{ method: "Page.javascriptDialogClosed" }] };
        default:
          return {};
      }
    };
    const provider = new DeviceBrowserProvider(odd);
    const page = await provider.navigate(computer, { url: FORM }, context());
    expect(page).toMatchObject({
      url: "",
      title: "",
      loading: true,
      dialog: "The page has a dialog open.",
    });
    await odd({ method: "Page.handleJavaScriptDialog" });
    // The closing event arrives with the next answer the provider reads.
    const closing = new DeviceBrowserProvider(async (command) =>
      command.method === "Page.getNavigationHistory"
        ? {
            events: [{ method: "Page.javascriptDialogClosed" }],
            result: { currentIndex: 0, entries: [{ url: 42 }] },
          }
        : odd(command),
    );
    const after = await closing.snapshot(computer, {}, context());
    expect(after).toMatchObject({ url: "42", tree: "(no interactive elements)" });
    expect(after.dialog).toBeUndefined();
    const acted = await closing.act(
      computer,
      { actions: [{ kind: "fill", ref: "e1", text: "a", origin: "https://example.test" }] },
      context(),
    );
    expect(acted.error).toBe("The page is not on the site this text is for.");
    const missing = await closing.act(
      computer,
      { actions: [{ kind: "click", ref: "e1" }] },
      context(),
    );
    expect(missing).toMatchObject({ uncertain: false, error: "The element is not on the page." });
    expect(await closing.screenshot()).toBeUndefined();
  });

  it("reports a refusal that is not an error object", async () => {
    const device = fakeDeviceBrowser(seededDevicePages);
    const refusing = async (command: { method: string; params?: Record<string, unknown> }) => {
      if (command.method === "DOM.getBoxModel") throw "refused";
      return device(command);
    };
    const provider = new DeviceBrowserProvider(refusing);
    await provider.navigate(computer, { url: FORM }, context());
    const acted = await provider.act(
      computer,
      { actions: [{ kind: "click", ref: "e12" }] },
      context(),
    );
    expect(acted).toMatchObject({ uncertain: false, error: "refused" });
  });
});

describe("the stand-in browser", () => {
  it("behaves as the provider expects before and after a page", async () => {
    const device = fakeDeviceBrowser({
      "https://f.test/": {
        title: "F",
        nodes: [
          { role: "checkbox", name: "Agree", checked: true },
          { role: "textbox", name: "Name", value: "Ada" },
        ],
      },
    });
    const history = await device({ method: "Page.getNavigationHistory" });
    expect(history.result).toMatchObject({ entries: [{ url: "about:blank", title: "" }] });
    expect(
      ((await device({ method: "Accessibility.getFullAXTree" })).result as { nodes: unknown[] })
        .nodes,
    ).toHaveLength(1);
    await device({ method: "Input.insertText", params: { text: "x" } });
    await device({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", text: "x" } });
    await device({ method: "Page.navigate", params: { url: "https://f.test/" } });
    const tree = await device({ method: "Accessibility.getFullAXTree" });
    expect(JSON.stringify(tree.result)).toContain('"checked"');
    expect(JSON.stringify(tree.result)).toContain('"Ada"');
    await device({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 1, y: 45, clickCount: 1 },
    });
    await device({ method: "Input.insertText", params: { text: "!" } });
    await device({ method: "Input.dispatchKeyEvent", params: { type: "keyDown", text: "?" } });
    await device({ method: "Input.dispatchKeyEvent", params: { type: "keyUp", key: "?" } });
    expect(device.value(11)).toBe("!?");
    await device({
      method: "Input.dispatchMouseEvent",
      params: { type: "mousePressed", x: 1, y: 400, clickCount: 1 },
    });
    await device({ method: "Input.insertText", params: { text: "lost" } });
    expect(device.value(11)).toBe("!?");
    await expect(device({ method: "Runtime.evaluate" })).rejects.toThrow("Not allowed");
  });
});

describe("readAccessibilityTree", () => {
  const node = (id: number, role: string, name: string, extra: object = {}) => ({
    nodeId: String(id),
    role: { value: role },
    name: { value: name },
    backendDOMNodeId: id,
    ...extra,
  });

  it("lists controls with their state, skips ignored nodes and text a control already names", () => {
    const { tree, elements } = readAccessibilityTree([
      node(1, "RootWebArea", "Page", { childIds: ["2", "4", "5", "6"] }),
      node(2, "button", "  Save   now ", { childIds: ["3"] }),
      node(3, "StaticText", "Save now"),
      node(4, "checkbox", "Remember", {
        properties: [{ name: "checked", value: { value: true } }],
      }),
      node(5, "heading", "Account"),
      node(6, "link", "Hidden", { ignored: true }),
    ]);
    expect(tree).toBe(
      '- button "Save now" [e2]\n- checkbox "Remember" [e4] checked\n- heading "Account"',
    );
    expect(elements).toEqual([
      { ref: "e2", role: "button", name: "Save now" },
      { ref: "e4", role: "checkbox", name: "Remember" },
    ]);
  });

  it("finds controls by words, says when nothing is there, and cuts a long page", () => {
    const nodes = [node(1, "button", "Subscribe"), node(2, "button", "Cancel")];
    expect(readAccessibilityTree(nodes, "subscribe").elements.map((e) => e.name)).toEqual([
      "Subscribe",
    ]);
    expect(readAccessibilityTree([]).tree).toBe("(no interactive elements)");
    const long = Array.from({ length: 900 }, (_, index) =>
      node(index + 1, "link", `Link ${index}`),
    );
    const { tree } = readAccessibilityTree(long);
    expect(tree.split("\n")).toHaveLength(801);
    expect(tree).toMatch(/the page goes on/);
  });

  it("reads only refs it gives", () => {
    expect(refNode("e42")).toBe(42);
    for (const ref of ["42", "e", "e-1", "e1.5", undefined, "e1234567890123"])
      expect(refNode(ref)).toBeUndefined();
  });
});

describe("a login the computer's password manager fills", () => {
  const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";
  const SITE = "https://example.test";
  type Fill = { ref: number; origin: string; handle: string; field: string };

  function linked(answer: (request: Fill) => Promise<unknown> = async () => ({ filled: true })) {
    const device = fakeDeviceBrowser(seededDevicePages);
    const sent: Fill[] = [];
    const provider = new DeviceBrowserProvider(device, async (request) => {
      sent.push(request);
      return answer(request);
    });
    return { device, provider, sent };
  }
  const step = (text: string, extra: Record<string, unknown> = {}) => ({
    kind: "fill" as const,
    ref: "e11",
    text,
    origin: SITE,
    field: "password" as const,
    ...extra,
  });

  it("asks the computer to fill the node and sends no value, no click and no key", async () => {
    const { provider, device, sent } = linked();
    await provider.navigate(computer, { url: FORM }, context());
    const before = device.commands.length;
    const key = provider.planFill({ handle: HANDLE, field: "username" });
    const done = await provider.act(
      computer,
      { actions: [step(key), { kind: "click", ref: "e12" }] },
      context(),
    );
    expect(done).toMatchObject({ ok: true, completed: 2, url: FORM });
    expect(sent).toEqual([{ ref: 11, origin: SITE, handle: HANDLE, field: "username" }]);
    // The step's own field is not what the computer is told: the login's is.
    expect(JSON.stringify(sent)).not.toContain(key);
    expect(device.value(11)).toBeUndefined();
    const methods = device.commands.slice(before).map((command) => command.method);
    expect(methods).not.toContain("Input.insertText");
    expect(methods.filter((method) => method === "Input.dispatchMouseEvent")).toHaveLength(3);
  });

  it("uses a key once, and types nothing for one it never gave", async () => {
    const { provider, device, sent } = linked();
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    await provider.act(computer, { actions: [step(key)] }, context());
    const before = device.commands.length;
    for (const text of [key, `${key.slice(0, key.indexOf(":") + 1)}made-up`]) {
      const refused = await provider.act(computer, { actions: [step(text)] }, context());
      expect(refused).toMatchObject({
        ok: false,
        completed: 0,
        uncertain: false,
        error: UNSUPPORTED_STEP,
      });
    }
    expect(sent).toHaveLength(1);
    expect(device.commands.slice(before).map((command) => command.method)).not.toContain(
      "Input.insertText",
    );
  });

  it("is not available to a browser with no computer behind it, or a step with no site", async () => {
    const bare = setup();
    await bare.provider.navigate(computer, { url: FORM }, context());
    const key = bare.provider.planFill({ handle: HANDLE, field: "password" });
    expect((await bare.provider.act(computer, { actions: [step(key)] }, context())).error).toBe(
      UNSUPPORTED_STEP,
    );
    const { provider, sent } = linked();
    await provider.navigate(computer, { url: FORM }, context());
    const other = provider.planFill({ handle: HANDLE, field: "password" });
    const open = await provider.act(
      computer,
      { actions: [{ ...step(other), origin: undefined }] },
      context(),
    );
    expect(open.error).toBe(UNSUPPORTED_STEP);
    expect(sent).toEqual([]);
  });

  it("asks nothing of the computer while the page is on another site than the one approved", async () => {
    const { provider, sent } = linked();
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    const refused = await provider.act(
      computer,
      { actions: [step(key, { origin: "https://other.test" })] },
      context(),
    );
    expect(refused).toMatchObject({
      ok: false,
      uncertain: false,
      error: "The page is not on the site this text is for.",
    });
    expect(sent).toEqual([]);
  });

  it.each([
    ["passwords-off", "The password manager is turned off in the desktop app."],
    [
      "passwords-unlinked",
      "This login is no longer linked in the desktop app. Link it there again.",
    ],
    ["passwords-origin", "The page is not on the site this login is for, so nothing was filled."],
    ["passwords-field", "This login cannot be typed into that field."],
    ["passwords-denied", "The user did not allow this login to be filled on this site."],
    [
      "passwords-locked",
      "The password manager is locked or did not approve. Ask the user to unlock it, then try again.",
    ],
    ["passwords-failed", "The password manager could not give this login."],
  ])("says %s in one sentence, nothing was typed", async (code, sentence) => {
    const { provider } = linked(async () => {
      throw new Error(code);
    });
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    expect(await provider.act(computer, { actions: [step(key)] }, context())).toMatchObject({
      ok: false,
      completed: 0,
      uncertain: false,
      error: sentence,
    });
  });

  it("never quotes what else the computer said, and is unsure what it did", async () => {
    const { provider } = linked(async () => {
      throw new Error("NOT_HERE: page text with a hunter2");
    });
    const proto = linked(async () => {
      throw new Error("constructor");
    });
    await proto.provider.navigate(computer, { url: FORM }, context());
    const protoKey = proto.provider.planFill({ handle: HANDLE, field: "password" });
    expect(
      (await proto.provider.act(computer, { actions: [step(protoKey)] }, context())).error,
    ).toBe(DEVICE_FILL_FAILED);
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    const result = await provider.act(computer, { actions: [step(key)] }, context());
    expect(result).toMatchObject({ ok: false, uncertain: true, error: DEVICE_FILL_FAILED });
    expect(JSON.stringify(result)).not.toContain("hunter2");
    const odd = linked(async () => {
      throw "not an error object";
    });
    await odd.provider.navigate(computer, { url: FORM }, context());
    const again = odd.provider.planFill({ handle: HANDLE, field: "password" });
    expect((await odd.provider.act(computer, { actions: [step(again)] }, context())).error).toBe(
      DEVICE_FILL_FAILED,
    );
  });

  it("is unsure too when the computer answers anything but that it filled", async () => {
    const { provider } = linked(async () => ({ filled: false }));
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    expect(await provider.act(computer, { actions: [step(key)] }, context())).toMatchObject({
      ok: false,
      uncertain: true,
      error: DEVICE_FILL_FAILED,
    });
  });

  it("stops when the call was cancelled, rather than reporting a failed fill", async () => {
    const controller = new AbortController();
    const { provider } = linked(async () => {
      controller.abort();
      throw new Error("aborted");
    });
    await provider.navigate(computer, { url: FORM }, context());
    const key = provider.planFill({ handle: HANDLE, field: "password" });
    await expect(
      provider.act(computer, { actions: [step(key)] }, { ...context(), signal: controller.signal }),
    ).rejects.toThrow();
  });
});
