import type { BrowserProvider } from "@rakazo/adapter-kit";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  counts: new Map<string, number>(),
  limit: 50,
}));
// The conditional upsert as Postgres runs it (packages/db/src/dozo-send-limit.ts): one account and bot per key.
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  takeDozoDailySend: async (
    _db: unknown,
    send: { userId: string; botId: string; sends: number },
  ) => {
    const key = `${send.userId}|${send.botId}`;
    const next = (db.counts.get(key) ?? 0) + send.sends;
    if (next > db.limit) return { full: true, dailySends: db.limit };
    db.counts.set(key, next);
    return { full: false };
  },
}));

import { ComputerBrowserProvider } from "./computers/screens/computer-browser.js";
import type { DevicePage } from "./dozo-device-browser.test-support.js";
import { fakeDeviceBrowser } from "./dozo-device-browser.test-support.js";
import { couldSubmit, dozoNotePageSubmits, sendingSteps, submitsIn } from "./dozo-page-submit.js";
import { dozoPageSubmits } from "./dozo-page-submit-gate.js";
import { dozoSendLimitCard, dozoSendLimitGate, dozoSendLimitHeld } from "./dozo-send-limit.js";
import { userBrowserGate } from "./dozo-user-browser-gate.js";
import { buildApprovalAskBlock } from "./dozo-user-computer-gate.js";
import { detectPurchase } from "./payments/purchase-gate.js";
import type { RunContext } from "./runs/assembly/run-context.js";
import type { ToolRequest } from "./runs/tools/run-tool-request.js";
import { prepareToolRequest } from "./runs/tools/run-tool-request.js";

const PAGE = "https://example.test/contact";
// The refs of the page below: node i is e(10 + i).
const REF = {
  field: "e10",
  send: "e11",
  link: "e12",
  menu: "e13",
  outside: "e14",
  like: "e15",
  searchField: "e16",
  go: "e17",
  newsletterField: "e18",
  join: "e19",
  notes: "e20",
  disabled: "e21",
  dialog: "e22",
  named: "e23",
  override: "e24",
};

const pages: Record<string, DevicePage> = {
  [PAGE]: {
    title: "Contact",
    forms: {
      post: { id: "post", method: "post" },
      find: { role: "search" },
      news: { id: "news" },
    },
    nodes: [
      { role: "textbox", name: "Name", tag: "INPUT", attrs: { type: "text" }, form: "post" },
      { role: "button", name: "Send", tag: "BUTTON", form: "post" },
      { role: "link", name: "Docs", tag: "A" },
      { role: "button", name: "Menu", tag: "BUTTON", attrs: { type: "button" }, form: "post" },
      { role: "button", name: "Outside", tag: "BUTTON" },
      { role: "button", name: "Like", tag: "DIV", attrs: { role: "button" } },
      { role: "searchbox", name: "Search", tag: "INPUT", attrs: { type: "search" }, form: "find" },
      { role: "button", name: "Go", tag: "BUTTON", form: "find" },
      { role: "textbox", name: "Email", tag: "INPUT", attrs: { type: "email" }, form: "news" },
      { role: "button", name: "Join", tag: "BUTTON", attrs: { type: "submit" }, form: "news" },
      { role: "textbox", name: "Notes", tag: "TEXTAREA", form: "post" },
      { role: "button", name: "Wait", tag: "BUTTON", attrs: { disabled: "" }, form: "post" },
      {
        role: "button",
        name: "Close",
        tag: "BUTTON",
        attrs: { formmethod: "dialog" },
        form: "post",
      },
      { role: "button", name: "Apart", tag: "INPUT", attrs: { type: "submit", form: "post" } },
      {
        role: "button",
        name: "Post it",
        tag: "BUTTON",
        attrs: { formmethod: "post" },
        form: "news",
      },
    ],
  },
};

/** A run whose bot works in the user's own browser, on a page seeded above. */
function userRun(options: { failing?: boolean; empty?: boolean; offline?: boolean } = {}) {
  const device = fakeDeviceBrowser(pages);
  const requests: string[] = [];
  const ctx = {
    source: { userComputerOwner: "user-1" },
    deps: {
      prisma: {
        $queryRaw: async (strings: TemplateStringsArray) =>
          strings.join("?").includes("dozo_token_taints")
            ? [{ sourced: false }]
            : ["", "open:example.test", "read:example.test", "act:example.test"].map((site) => ({
                site,
              })),
        attempt: { count: async () => 1 },
      },
      userDevices: {
        connected: async () =>
          options.offline ? null : { deviceId: "d1", capabilities: ["shell", "browser"] },
        async *request(_owner: string, request: { method: string; command?: never }) {
          if (request.method !== "pageBrowser") {
            yield { cleared: false };
            return;
          }
          requests.push(String((request.command as { method?: string } | undefined)?.method));
          if (options.failing) throw new Error("the connection dropped");
          if (options.empty) {
            yield {};
            return;
          }
          yield await device(request.command as never);
        },
      },
    },
    bot: { id: "bot-1", name: "Ada" },
    thread: { id: "thread-1" },
    run: { userId: "user-1" },
    state: {},
    runId: "run-1",
    context: { signal: new AbortController().signal },
    computer: { graphical: false },
    tools: { disabled: new Set<string>() },
  } as unknown as RunContext;
  return { ctx, requests, device };
}

async function submits(actions: unknown[], options?: { failing?: boolean }) {
  const run = userRun(options);
  await run.device({ method: "Page.navigate", params: { url: PAGE } });
  return { count: await dozoPageSubmits(run.ctx, "browser_act", { actions }), run };
}
const click = (ref: string) => ({ kind: "click", ref });

describe("which presses are form submits, in the user's own browser", () => {
  it.each([
    ["a submit button in a POST form", [click(REF.send)], 1],
    ["Enter typed into a field of that form", [{ kind: "type", ref: REF.field, text: "Ada\n" }], 1],
    ["typing without a line break", [{ kind: "type", ref: REF.field, text: "Ada" }], 0],
    ["filling a field", [{ kind: "fill", ref: REF.field, text: "Ada\n" }], 0],
    ["a link", [click(REF.link)], 0],
    ["a button that is not a submit", [click(REF.menu)], 0],
    ["a button outside any form", [click(REF.outside)], 0],
    ["a script's button (role=button on a div)", [click(REF.like)], 0],
    ["a search form's button", [click(REF.go)], 0],
    ["Enter in a search field", [{ kind: "type", ref: REF.searchField, text: "x\n" }], 0],
    ["a form read with GET that is not a search", [click(REF.join)], 1],
    [
      "Enter in a text area, which breaks the line",
      [{ kind: "type", ref: REF.notes, text: "a\n" }],
      0,
    ],
    ["a disabled button", [click(REF.disabled)], 0],
    ["a button that closes a dialog", [click(REF.dialog)], 0],
    ["a submit named to a form by its attribute", [click(REF.named)], 1],
    ["a button that posts a GET form", [click(REF.override)], 1],
    ["every submit of a batch", [click(REF.send), click(REF.link), click(REF.send)], 2],
    ["an element the DOM does not hold", [click("e999")], 1],
    ["a ref that is not the browser's", [click("nope")], 1],
  ])("%s", async (_what, actions, expected) => {
    expect((await submits(actions)).count).toBe(expected);
  });

  it("asks the page only about presses that could send, and reads nothing else", async () => {
    const { run } = await submits([{ kind: "fill", ref: REF.field, text: "x" }, click(REF.send)]);
    expect(run.requests.filter((method) => method === "DOM.getDocument")).toHaveLength(1);
    // Presses that cannot submit are settled from their own element: the page is not read for them.
    const quiet = await submits([click(REF.link), click(REF.menu), click(REF.like)]);
    expect(quiet.run.requests).not.toContain("DOM.getDocument");
    expect(quiet.run.requests.filter((method) => method === "DOM.describeNode")).toHaveLength(3);
    // The desktop passes a depth that is a whole number, which -1 is not.
    const read = run.device.commands.find((command) => command.method === "DOM.getDocument");
    expect(Number.isInteger(read?.params?.depth) && Number(read?.params?.depth) > 0).toBe(true);
    const none = userRun();
    expect(
      await dozoPageSubmits(none.ctx, "browser_act", {
        actions: [{ kind: "fill", ref: REF.field, text: "x" }],
      }),
    ).toBe(0);
    for (const name of ["browser_navigate", "browser_snapshot"])
      expect(await dozoPageSubmits(none.ctx, name, { url: PAGE })).toBe(0);
    expect(none.requests).toEqual([]);
  });

  it("counts each press as a submit when the page cannot be read", async () => {
    expect((await submits([click(REF.link), click(REF.send)], { failing: true })).count).toBe(2);
  });

  it("keeps nothing of what it reads: no log, no event, no argument carries the page", async () => {
    const canary = "CANARY-private-page-text";
    const secret: Record<string, DevicePage> = {
      [PAGE]: {
        ...pages[PAGE]!,
        forms: { ...pages[PAGE]!.forms, post: { id: canary, method: "post", "data-note": canary } },
      },
    };
    const device = fakeDeviceBrowser(secret);
    await device({ method: "Page.navigate", params: { url: PAGE } });
    const run = userRun();
    const reached: boolean[] = [];
    (run.ctx.deps.userDevices as { request: unknown }).request = async function* (
      _owner: string,
      request: { command?: never },
    ) {
      const answer = await device(request.command as never);
      reached.push(JSON.stringify(answer).includes(canary));
      yield answer;
    };
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const args = { actions: [click(REF.send)] };
    const before = JSON.stringify(args);
    const count = await dozoPageSubmits(run.ctx, "browser_act", args);
    const logged = spies.flatMap((spy) => spy.mock.calls);
    for (const spy of spies) spy.mockRestore();
    expect(count).toBe(1);
    // The page did reach the server, as it must to be judged...
    expect(reached).toContain(true);
    // ...and nothing of it is left: the answer is a number, the call and the run are untouched.
    expect(logged).toEqual([]);
    expect(JSON.stringify(args)).toBe(before);
    expect(JSON.stringify(run.ctx.state)).not.toContain(canary);
    expect(JSON.stringify(Object.entries(run.ctx))).not.toContain(canary);
  });

  it("counts each press as a submit when the page's answer holds no document", async () => {
    const run = userRun({ empty: true });
    const actions = [click(REF.link), click(REF.send)];
    expect(await dozoPageSubmits(run.ctx, "browser_act", { actions })).toBe(2);
  });

  it("falls back to the computer's answer when the user's computer has no browser to reach", async () => {
    const actions = [click(REF.send)];
    dozoNotePageSubmits("browser_act", { actions }, 1);
    const offline = userRun({ offline: true });
    expect(await dozoPageSubmits(offline.ctx, "browser_act", { actions })).toBe(1);
    const ownerless = { ...userRun().ctx, source: {} } as unknown as RunContext;
    expect(await dozoPageSubmits(ownerless, "browser_act", { actions })).toBe(1);
  });

  it("reads the steps of a call as the browser tool does, and sparse nodes without failing", () => {
    expect(
      sendingSteps([
        null,
        { kind: "click" },
        { kind: "type", text: 5 },
        { kind: "type", ref: " e5 ", text: "a\n" },
        { kind: "fill", ref: "e1", text: "a\n" },
      ]),
    ).toEqual([
      { kind: "click", ref: undefined, text: "" },
      { kind: "type", ref: "e5", text: "a\n" },
    ]);
    const bare = { backendNodeId: 3 };
    const form = {
      nodeName: "FORM",
      attributes: ["method"],
      children: [
        { backendNodeId: 4, nodeName: "BUTTON", attributes: ["formmethod", "", "id"] },
        bare,
      ],
    };
    expect(
      submitsIn({ children: [form] }, [
        { kind: "click", ref: "e3" },
        { kind: "click", ref: "e4" },
      ]),
    ).toBe(1);
    expect(couldSubmit(bare, { kind: "click" })).toBe(false);
  });

  it("finds elements inside frames and shadow trees, and no form of an unlinked id", () => {
    const button = { backendNodeId: 5, nodeName: "BUTTON", attributes: ["form", "ghost"] };
    const inner = { backendNodeId: 6, nodeName: "BUTTON" };
    const root = {
      nodeName: "#document",
      children: [
        { nodeName: "FORM", attributes: ["method", "post"], shadowRoots: [{ children: [inner] }] },
        { nodeName: "IFRAME", contentDocument: { children: [button] } },
      ],
    };
    expect(submitsIn(root, [{ kind: "click", ref: "e5" }])).toBe(0);
    expect(submitsIn(root, [{ kind: "click", ref: "e6" }])).toBe(1);
    expect(submitsIn(undefined, [{ kind: "click", ref: "e6" }])).toBe(1);
    // An element the page's document does not hold (one the desktop did not return) counts.
    expect(submitsIn(root, [{ kind: "click", ref: "e99" }])).toBe(1);
    // What the element alone settles.
    const input = (type: string) => ({ nodeName: "INPUT", attributes: ["type", type] });
    expect(couldSubmit(input("submit"), { kind: "click" })).toBe(true);
    expect(couldSubmit({ nodeName: "A" }, { kind: "click" })).toBe(false);
    expect(couldSubmit(input("text"), { kind: "type", text: "\n" })).toBe(true);
    expect(couldSubmit(input("checkbox"), { kind: "type", text: "\n" })).toBe(false);
    expect(couldSubmit({ nodeName: "TEXTAREA" }, { kind: "type", text: "\n" })).toBe(false);
    // A search nested in a landmark, or a form inside one, is still a search.
    const search = {
      nodeName: "DIV",
      attributes: ["role", "search"],
      children: [{ nodeName: "FORM", children: [{ backendNodeId: 7, nodeName: "BUTTON" }] }],
    };
    expect(submitsIn({ children: [search] }, [{ kind: "click", ref: "e7" }])).toBe(0);
  });
});

describe("which presses are form submits, on the bot's computer", () => {
  const actions = [click("e1"), click("e2")];

  it("takes what the computer's page browser said about the same clicks, and nothing otherwise", async () => {
    const ctx = {} as RunContext;
    expect(await dozoPageSubmits(ctx, "browser_act", { actions })).toBe(0);
    dozoNotePageSubmits("browser_act", { actions }, 2);
    expect(await dozoPageSubmits(ctx, "browser_act", { actions })).toBe(2);
    // Another list of actions, another tool, or a computer that does not say, is not that answer.
    expect(await dozoPageSubmits(ctx, "browser_act", { actions: [...actions] })).toBe(0);
    expect(await dozoPageSubmits(ctx, "computer_act", { actions })).toBe(0);
    dozoNotePageSubmits("computer_act", { actions: [] }, 3);
    dozoNotePageSubmits("browser_act", { actions: "x" }, 3);
    dozoNotePageSubmits("browser_act", { actions: [] }, undefined);
  });

  it("passes the count of an image that reports it, and none from one that does not", async () => {
    const computer = { id: "c1", botId: "b", kind: "boat", providerRef: "x" } as never;
    const context = { signal: new AbortController().signal } as never;
    const answer = { ok: true, site: "a.test", url: "", title: "", purchase: null };
    let reply: Record<string, unknown> = { ...answer, submits: 2 };
    const provider = new ComputerBrowserProvider({ liveDriver: async () => reply as never });
    expect(await provider.purchaseCheck(computer, { actions }, context)).toEqual({
      purchase: null,
      submits: 2,
    });
    reply = { ...answer, submits: 1, purchase: { steps: [1], label: "Pay", amount: "$5" } };
    expect(await provider.purchaseCheck(computer, { actions }, context)).toMatchObject({
      purchase: { steps: [1] },
      submits: 1,
    });
    for (const none of [{ ...answer }, { ...answer, submits: 0 }, { ...answer, submits: "2" }]) {
      reply = none;
      expect(await provider.purchaseCheck(computer, { actions }, context)).toEqual({
        purchase: null,
      });
    }
  });

  it("is told by the check that runs before the call, through the tool request", async () => {
    const check = vi.fn(async () => ({ purchase: null, submits: 2 }));
    const ctx = {
      deps: {},
      run: { spaceId: "s", userId: "u" },
      bot: { id: "b" },
      context: { signal: new AbortController().signal },
      providers: { browser: { purchaseCheck: check } as unknown as BrowserProvider },
      state: { walletHosts: new Set<string>() },
      secrets: [],
      computer: {
        pageBrowserAllowed: true,
        heldForTakeover: false,
        get: async () => ({ id: "c" }),
      },
    } as unknown as RunContext;
    const request = { name: "browser_act", args: { actions } } as unknown as ToolRequest;
    expect(await prepareToolRequest(ctx, request)).toBeUndefined();
    expect(await dozoPageSubmits(ctx, "browser_act", request.args)).toBe(2);
    // A press on the screen is not this count's: computer_act stays a limit of it.
    const screen = [{ kind: "click", x: 1, y: 2 }];
    await detectPurchase(ctx, "computer_act", { actions: screen });
    expect(await dozoPageSubmits(ctx, "computer_act", { actions: screen })).toBe(0);
  });
});

describe("the daily limit on page submits", () => {
  const ctx = (userId: string, botId: string) =>
    ({ deps: { prisma: {} }, run: { userId }, bot: { id: botId } }) as unknown as RunContext;
  const press = (count: number) => {
    const actions = Array.from({ length: count }, (_, at) => click(`e${at}`));
    dozoNotePageSubmits("browser_act", { actions }, count);
    return {
      name: "browser_act",
      args: { actions },
      viaConnector: false,
      connectorChanges: 0,
      approved: false,
    };
  };

  beforeEach(() => {
    db.counts.clear();
    db.limit = 3;
  });

  it("lets the day's number of submits go ahead, and asks for the next one", async () => {
    const run = ctx("u1", "b1");
    for (let sent = 0; sent < 3; sent += 1)
      expect(await dozoSendLimitGate(run, press(1), "allow")).toBe("allow");
    const held = press(1);
    expect(await dozoSendLimitGate(run, held, "allow")).toBe("ask");
    expect(dozoSendLimitHeld(held.args)).toBe(true);
    expect(await dozoSendLimitGate(run, press(1), "judge")).toBe("ask");
    // The card says why, and offers Allow once and Deny only.
    expect(dozoSendLimitCard(held.args, undefined)).toMatchObject({
      onceOnly: true,
      reviewReason: "Over the daily limit: this bot may make 3 sends a day without asking.",
    });
  });

  it("counts a batch's submits together, and none of them when they do not fit", async () => {
    const run = ctx("u1", "b1");
    expect(await dozoSendLimitGate(run, press(2), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(run, press(2), "allow")).toBe("ask");
    expect(await dozoSendLimitGate(run, press(1), "allow")).toBe("allow");
    expect(db.counts.get("u1|b1")).toBe(3);
  });

  it("counts nothing for a press that is not a submit, or a call a person already decided", async () => {
    const run = ctx("u1", "b1");
    db.limit = 0;
    const plain = {
      name: "browser_act",
      args: { actions: [click("e1")] },
      viaConnector: false,
      connectorChanges: 0,
      approved: false,
    };
    expect(await dozoSendLimitGate(run, plain, "allow")).toBe("allow");
    expect(await dozoSendLimitGate(run, press(1), "ask")).toBe("ask");
    expect(await dozoSendLimitGate(run, press(1), "deny")).toBe("deny");
    expect(await dozoSendLimitGate(run, { ...press(1), approved: true }, "allow")).toBe("allow");
    expect(db.counts.size).toBe(0);
  });

  it("keeps each account's and each bot's day apart", async () => {
    expect(await dozoSendLimitGate(ctx("u1", "b1"), press(3), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(ctx("u1", "b1"), press(1), "allow")).toBe("ask");
    expect(await dozoSendLimitGate(ctx("u1", "b2"), press(3), "allow")).toBe("allow");
    expect(await dozoSendLimitGate(ctx("u2", "b1"), press(3), "allow")).toBe("allow");
  });

  it("holds a call in the user's browser with the limit's card, not the browser's own question", async () => {
    db.limit = 0;
    const run = userRun();
    await run.device({ method: "Page.navigate", params: { url: PAGE } });
    const args = { actions: [click(REF.send)] };
    // What the browser's own approval allows, then the limit on top of it, as the gate chains them.
    const plan = await userBrowserGate(run.ctx, false, "browser_act", args);
    expect(plan).toBe("allow");
    const call = {
      name: "browser_act",
      args,
      viaConnector: false,
      connectorChanges: 0,
      approved: false,
    };
    expect(await dozoSendLimitGate(run.ctx, call, plan)).toBe("ask");
    const card = buildApprovalAskBlock("effect-1", "browser_act", args, []);
    expect(JSON.stringify(card)).toContain("Over the daily limit");
    expect(JSON.stringify(card)).not.toContain("in its browser");
    // A press that is not a submit is not held.
    const read = { actions: [click(REF.link)] };
    expect(await userBrowserGate(run.ctx, false, "browser_act", read)).toBe("allow");
    expect(await dozoSendLimitGate(run.ctx, { ...call, args: read }, "allow")).toBe("allow");
    // The browser's own card is for what the browser itself asks.
    expect(JSON.stringify(buildApprovalAskBlock("effect-2", "browser_act", read, []))).toContain(
      "in its browser",
    );
  });
});
