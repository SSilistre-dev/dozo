import { beforeEach, describe, expect, it, vi } from "vitest";

const withheld = vi.hoisted(() => ({ value: false }));
vi.mock("./run-tools-computer.js", () => ({
  pageBrowserTool: vi.fn(async () => "the bot's computer"),
}));
vi.mock("./dozo-no-computer.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-no-computer.js")>()),
  filesWithoutComputer: () => (withheld.value ? { error: "none" } : undefined),
}));

import type { DeviceBrowserEvent } from "./dozo-device-browser.js";
import { fakeDeviceBrowser, seededDevicePages } from "./dozo-device-browser.test-support.js";
import { withoutCloudComputerTools } from "./dozo-no-computer.js";
import { pageBrowserTool, USER_BROWSER_NOTE, userBrowserSignIn } from "./dozo-user-browser.js";
import { pageSite, routesToUserBrowser, userBrowserGate } from "./dozo-user-browser-gate.js";
import { buildApprovalAskBlock } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

const FORM = "https://example.test/form";

/** A run with the user's computer connected, a consent table, effects and a token mark, in memory. */
function setup(options: { capabilities?: string[]; owner?: string; token?: boolean } = {}) {
  const consents = new Set<string>();
  const signIn = { answer: true as unknown };
  const effects = new Map<string, { id: string; request: unknown }>();
  const device = fakeDeviceBrowser({
    ...seededDevicePages,
    "https://other.test/": { title: "Other", nodes: [{ role: "button", name: "Elsewhere" }] },
  });
  const requests: Array<{ method: string }> = [];
  const devices = {
    connected: vi.fn(async () => ({
      deviceId: "device-1",
      name: "Laptop",
      platform: "darwin",
      capabilities: options.capabilities ?? ["shell", "browser"],
    })),
    pairedSince: async () => new Date(0),
    async *request(_owner: string, request: { method: string; command?: never }) {
      requests.push(request);
      if (request.method === "pageBrowserSignIn") {
        yield { signedIn: signIn.answer };
        return;
      }
      if (request.method === "pageBrowser") {
        const answer: { result?: unknown; events?: DeviceBrowserEvent[] } = await device(
          request.command as never,
        );
        yield answer;
      } else yield { id: "desktop-x" };
    },
  };
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (sql(strings).includes("dozo_token_taints")) return [{ sourced: Boolean(options.token) }];
      if (sql(strings).includes("FROM dozo_browser_consents"))
        return [...consents]
          .filter((key) => key.startsWith(`${values[0]}|${values[1]}|${values[2]}|`))
          .map((key) => ({ site: key.split("|")[3] }));
      throw new Error(`unexpected SQL ${sql(strings)}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!sql(strings).includes("INSERT INTO dozo_browser_consents"))
        throw new Error("unexpected");
      consents.add(values.join("|"));
      return 1;
    }),
    externalEffect: {
      findUnique: async ({ where }: { where: { idempotencyKey: string } }) =>
        effects.get(where.idempotencyKey) ?? null,
    },
    attempt: { count: async () => 1 },
  };
  const ctx = {
    source: { userComputerOwner: "owner" in options ? options.owner : "user-1" },
    deps: { userDevices: devices, prisma },
    bot: { id: "bot-1" },
    thread: { id: "thread-1" },
    run: { botId: "bot-1", threadId: "thread-1", userId: "user-1" },
    runId: "run-1",
    context: { signal: new AbortController().signal },
    secrets: new Set<string>(["ada-secret"]),
    state: {} as { pageUrl?: string; tainted?: boolean },
    trust: { receivedOutsideMessage: async () => false },
    computer: { acceptsImages: true, stored: {}, graphical: false },
    tools: { disabled: new Set<string>() },
  } as unknown as RunContext;
  return { ctx, consents, effects, device, requests, devices, signIn };
}

/** What the person already allowed in thread-1: the browser, and each "verb:site" given. */
function allow(run: ReturnType<typeof setup>, ...given: string[]) {
  for (const entry of ["", ...given]) run.consents.add(`bot-1|device-1|thread-1|${entry}`);
}

let effectCount = 0;

function call(name: string, args: Record<string, unknown>, effectKey = `effect-${++effectCount}`) {
  return {
    name,
    args,
    effectKey,
    finish: vi.fn(async (result: unknown) => result),
  } as unknown as ToolCall & { finish: ReturnType<typeof vi.fn> };
}

/**
 * A call as the executor runs it: its approval first; when that asks, the person allows it and its
 * effect keeps the request as the gate left it; then its handler.
 */
async function approved(
  setupResult: ReturnType<typeof setup>,
  name: string,
  args: Record<string, unknown>,
) {
  const { ctx, effects } = setupResult;
  const plan = await userBrowserGate(ctx, false, name, args);
  const asked = call(name, args);
  if (plan === "ask") effects.set(asked.effectKey, { id: asked.effectKey, request: { ...args } });
  if (plan === "deny") throw new Error("denied");
  return { plan, result: await pageBrowserTool(ctx, asked), call: asked };
}

beforeEach(() => {
  withheld.value = false;
});

describe("where the page tools go", () => {
  it("to the user's own browser only in their own run, on a computer that declared one", async () => {
    expect(await routesToUserBrowser(setup().ctx, "browser_act")).toBe(true);
    expect(await routesToUserBrowser(setup().ctx, "user_computer_shell")).toBe(false);
    expect(await routesToUserBrowser(setup({ owner: undefined }).ctx, "browser_act")).toBe(false);
    expect(await routesToUserBrowser(setup({ capabilities: ["shell"] }).ctx, "browser_act")).toBe(
      false,
    );
    // A run with a graphical computer of its own keeps its own browser.
    const graphical = setup().ctx;
    (graphical.computer as { graphical: boolean }).graphical = true;
    expect(await routesToUserBrowser(graphical, "browser_act")).toBe(false);
    // The bot's owner turned off the user's computer for it.
    const off = setup().ctx;
    off.tools.disabled.add("user_computer_shell");
    expect(await routesToUserBrowser(off, "browser_act")).toBe(false);
  });

  it("reads the site of a page by its registrable domain", () => {
    expect(pageSite("https://www.x.com/home")).toBe("x.com");
    expect(pageSite("https://alice.github.io/a")).toBe("alice.github.io");
    for (const url of [undefined, "", "about:blank", "file:///etc/hosts", "nonsense"])
      expect(pageSite(url)).toBe("");
  });
});

describe("its approval", () => {
  it("refuses a blocked call and any call in a run a token's message reached", async () => {
    expect(await userBrowserGate(setup().ctx, true, "browser_snapshot", {})).toBe("deny");
    expect(await userBrowserGate(setup({ token: true }).ctx, false, "browser_snapshot", {})).toBe(
      "deny",
    );
  });

  it("asks once per thread for the browser, then once per site for each of open, read and act", async () => {
    const run = setup();
    const { ctx } = run;
    const first = { url: FORM };
    expect(await userBrowserGate(ctx, false, "browser_navigate", first)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_navigate", first, [])).toMatchObject({
      kind: "ask",
      text: "Let this bot use its own browser on your computer and open example.test?",
      detail: FORM,
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect((await approved(run, "browser_navigate", { url: FORM })).plan).toBe("ask");
    expect(run.consents).toEqual(
      new Set(["bot-1|device-1|thread-1|", "bot-1|device-1|thread-1|open:example.test"]),
    );
    expect(await userBrowserGate(ctx, false, "browser_navigate", { url: FORM })).toBe("allow");
    // Opening a site allows neither reading nor acting there: each asks on its own.
    const look = {};
    expect(await userBrowserGate(ctx, false, "browser_snapshot", look)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_snapshot", look, [])).toMatchObject({
      text: "Let this bot read example.test in its browser?",
    });
    expect((await approved(run, "browser_snapshot", {})).plan).toBe("ask");
    expect(await userBrowserGate(ctx, false, "browser_snapshot", {})).toBe("allow");
    const act = { actions: [{ kind: "fill", ref: "e11", text: "ada-secret" }] };
    expect(await userBrowserGate(ctx, false, "browser_act", act)).toBe("ask");
    const card = buildApprovalAskBlock("e", "browser_act", act, ["ada-secret"]);
    expect(card).toMatchObject({ text: "Let this bot act on example.test in its browser?" });
    expect((card as { detail: string }).detail).not.toContain("ada-secret");
    // Another site asks, naming it.
    const other = { url: "https://www.other.test/?d=secret" };
    expect(await userBrowserGate(ctx, false, "browser_navigate", other)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_navigate", other, [])).toMatchObject({
      text: "Let this bot open other.test in its browser?",
    });
    // Another thread asks again from the start.
    (ctx as { thread: { id: string } }).thread = { id: "thread-2" };
    const fresh = {};
    expect(await userBrowserGate(ctx, false, "browser_snapshot", fresh)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_snapshot", fresh, [])).toMatchObject({
      text: "Let this bot use its own browser on your computer?",
    });
    expect(buildApprovalAskBlock("e", "browser_snapshot", fresh, [])).not.toHaveProperty("detail");
  });

  it("asks again before opening another site once the run read something from outside", async () => {
    const run = setup();
    allow(run, "open:example.test", "open:other.test", "read:example.test");
    await approved(run, "browser_navigate", { url: FORM });
    // Allowed before, and nothing from outside read yet: it goes ahead.
    expect(
      await userBrowserGate(run.ctx, false, "browser_navigate", { url: "https://other.test/" }),
    ).toBe("allow");
    run.ctx.state.tainted = true;
    const away = { url: "https://other.test/?d=what-the-page-said" };
    expect(await userBrowserGate(run.ctx, false, "browser_navigate", away)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_navigate", away, [])).toMatchObject({
      text: "Let this bot open other.test in its browser?",
    });
    // The site it shows stays the bot's to open again.
    expect(await userBrowserGate(run.ctx, false, "browser_navigate", { url: FORM })).toBe("allow");
  });

  it("asks before reading a page whose site it cannot tell, but not a blank one", async () => {
    const run = setup();
    allow(run);
    expect(await userBrowserGate(run.ctx, false, "browser_snapshot", {})).toBe("allow");
    run.devices.request = async function* () {
      yield* [];
      throw new Error("the browser closed");
    } as never;
    const unknown = {};
    expect(await userBrowserGate(run.ctx, false, "browser_snapshot", unknown)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_snapshot", unknown, [])).toMatchObject({
      text: "Let this bot read this page in its browser?",
    });
    const act = { actions: [] };
    expect(await userBrowserGate(run.ctx, false, "browser_act", act)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_act", act, [])).toMatchObject({
      text: "Let this bot act on this page in its browser?",
    });
  });

  it("asks when the computer went away between the offer and the call", async () => {
    const { ctx, devices } = setup();
    devices.connected.mockResolvedValueOnce(null as never);
    expect(await userBrowserGate(ctx, false, "browser_snapshot", {})).toBe("ask");
  });
});

describe("its handler", () => {
  it("runs only a call its approval saw, and records nothing for one it did not", async () => {
    const run = setup();
    const unseen = call("browser_navigate", { url: FORM });
    await pageBrowserTool(run.ctx, unseen);
    expect(unseen.finish).toHaveBeenCalledWith({
      error: "The browser on the user's computer was not part of this call's approval. Try again.",
    });
    expect(run.requests).toHaveLength(0);
    expect(run.consents.size).toBe(0);
  });

  it("runs an asked call only on the site its card named", async () => {
    const run = setup();
    const args = { url: FORM };
    expect(await userBrowserGate(run.ctx, false, "browser_navigate", args)).toBe("ask");
    // The effect the person approved named another site (a resume after the page moved).
    const resumed = call("browser_navigate", args);
    run.effects.set(resumed.effectKey, {
      id: resumed.effectKey,
      request: { ...args, approvedSite: "other.test" },
    });
    await pageBrowserTool(run.ctx, resumed);
    expect(resumed.finish).toHaveBeenCalledWith({
      error: "The browser shows another site than the one the user approved. Ask again.",
    });
    // An effect that kept no site approves none.
    const old = call("browser_navigate", args);
    run.effects.set(old.effectKey, { id: old.effectKey, request: { url: FORM } });
    await pageBrowserTool(run.ctx, old);
    expect(old.finish.mock.calls[0]![0]).toMatchObject({
      error: expect.stringContaining("another site"),
    });
    expect(run.consents.size).toBe(0);
  });

  it("gives no look at, and takes no action on, a site the page left for since its approval", async () => {
    const run = setup();
    allow(run, "open:example.test", "read:example.test", "act:example.test");
    await approved(run, "browser_navigate", { url: FORM });
    const look = {};
    expect(await userBrowserGate(run.ctx, false, "browser_snapshot", look)).toBe("allow");
    const act = { actions: [{ kind: "click", ref: "e12" }] };
    expect(await userBrowserGate(run.ctx, false, "browser_act", act)).toBe("allow");
    // Another thread's run moves the bot's one page meanwhile.
    await run.device({ method: "Page.navigate", params: { url: "https://other.test/" } });
    const looked = call("browser_snapshot", look);
    await pageBrowserTool(run.ctx, looked);
    expect(looked.finish).toHaveBeenCalledWith({
      error: "The browser shows another site than the one the user approved. Ask again.",
    });
    const acted = (await pageBrowserTool(run.ctx, call("browser_act", act))) as { error: string };
    expect(acted.error).toMatch(/another site|went on to other\.test/);
  });

  it("gives no page of another site than the one approved, after a redirect, a link or a blank look", async () => {
    const run = setup();
    allow(run, "open:example.test", "act:example.test");
    // The bot opens example.test and the page goes on to other.test.
    const args = { url: FORM };
    expect(await userBrowserGate(run.ctx, false, "browser_navigate", args)).toBe("allow");
    const original = run.device;
    const redirecting = Object.assign(
      async (command: { method: string; params?: Record<string, unknown> }) =>
        command.method === "Page.navigate"
          ? original({ method: "Page.navigate", params: { url: "https://other.test/" } })
          : original(command),
      { commands: original.commands, value: original.value },
    );
    run.devices.request = async function* (
      _owner: string,
      req: { method: string; command?: never },
    ) {
      if (req.method === "pageBrowser") {
        yield await redirecting(req.command as never);
        return;
      }
      yield { id: "desktop-x" };
    } as never;
    const went = call("browser_navigate", args);
    await pageBrowserTool(run.ctx, went);
    expect(went.finish).toHaveBeenCalledWith({
      error: expect.stringMatching(/^The page went on to other\.test, which is not shown here/),
    });
    expect(JSON.stringify(went.finish.mock.calls)).not.toContain("Elsewhere");
    // A look allowed at a blank page is not given once the page shows a site.
    const blank = setup();
    allow(blank);
    const look = {};
    expect(await userBrowserGate(blank.ctx, false, "browser_snapshot", look)).toBe("allow");
    await blank.device({ method: "Page.navigate", params: { url: "https://other.test/" } });
    const looked = call("browser_snapshot", look);
    await pageBrowserTool(blank.ctx, looked);
    expect(looked.finish).toHaveBeenCalledWith({
      error: "The browser shows another site than the one the user approved. Ask again.",
    });
  });

  it("runs an approved call only on the computer it asked about", async () => {
    const run = setup();
    const args = { url: FORM };
    await userBrowserGate(run.ctx, false, "browser_navigate", args);
    run.devices.connected.mockResolvedValue({
      deviceId: "device-2",
      name: "Other",
      platform: "linux",
      capabilities: ["shell", "browser"],
    } as never);
    const moved = call("browser_navigate", args);
    await pageBrowserTool(run.ctx, moved);
    expect(moved.finish).toHaveBeenCalledWith({
      error: "The user's computer changed since this was approved. Try again.",
    });
  });

  it("provisions the bot there, drives the page and says once where the browser is", async () => {
    const run = setup();
    const navigated = (await approved(run, "browser_navigate", { url: FORM })).result as {
      details: { url: string; note: string };
    };
    expect(navigated.details).toMatchObject({ url: FORM, note: USER_BROWSER_NOTE });
    expect(run.ctx.state.pageUrl).toBe(FORM);
    expect(run.requests.find((request) => request.method === "provision")).toMatchObject({
      botId: "bot-1",
    });
    const again = (await approved(run, "browser_navigate", { url: FORM })).result as {
      details: { note?: string };
    };
    expect(again.details.note).toBeUndefined();
  });

  it("shows a model that can see what the page looks like, and keeps the text if it cannot", async () => {
    const run = setup();
    await approved(run, "browser_navigate", { url: FORM });
    const looked = (await approved(run, "browser_snapshot", {})).result as {
      content: Array<{ type: string; data?: string }>;
    };
    expect(looked.content.at(-1)).toEqual({
      type: "image",
      data: "c2NyZWVu",
      mimeType: "image/jpeg",
    });
    (run.ctx.computer as { acceptsImages: boolean }).acceptsImages = false;
    const blind = (await approved(run, "browser_snapshot", {})).result as {
      content: Array<{ type: string }>;
    };
    expect(blind.content.map((part) => part.type)).toEqual(["text"]);
    (run.ctx.computer as { acceptsImages: boolean }).acceptsImages = true;
    const request = run.devices.request;
    run.devices.request = async function* (
      owner: string,
      req: { method: string; command?: { method: string } },
    ) {
      if (req.command?.method === "Page.captureScreenshot") throw "no picture";
      yield* request(owner, req as never);
    } as never;
    const failed = (await approved(run, "browser_snapshot", {})).result as {
      content: Array<{ type: string }>;
    };
    expect(failed.content.map((part) => part.type)).toEqual(["text"]);
  });

  it("hides the run's secrets in what the page shows", async () => {
    const run = setup();
    await approved(run, "browser_navigate", { url: FORM });
    const acted = (
      await approved(run, "browser_act", {
        actions: [{ kind: "fill", ref: "e11", text: "ada-secret" }],
      })
    ).result as { content: Array<{ text: string }> };
    expect(acted.content[0]!.text).not.toContain("ada-secret");
  });

  it("refuses a run a token's message reached, even past the gate", async () => {
    const run = setup({ token: true });
    const refused = call("browser_snapshot", {});
    await pageBrowserTool(run.ctx, refused);
    expect(refused.finish).toHaveBeenCalledWith({
      error: "The browser on the user's computer is not used for a message sent with a token.",
    });
    expect(run.requests).toHaveLength(0);
  });

  it("goes to the bot's computer without a user's browser, unless the run has no computer", async () => {
    const { ctx } = setup({ capabilities: ["shell"] });
    expect(await pageBrowserTool(ctx, call("browser_snapshot", {}))).toBe("the bot's computer");
    withheld.value = true;
    const gone = call("browser_snapshot", {});
    await pageBrowserTool(ctx, gone);
    expect(gone.finish.mock.calls[0]![0]).toMatchObject({
      error: expect.stringContaining("not connected"),
    });
  });

  it("says when the computer did not finish, and stops with the run", async () => {
    const run = setup();
    allow(run, "open:example.test", "read:example.test");
    await approved(run, "browser_navigate", { url: FORM });
    const args = {};
    await userBrowserGate(run.ctx, false, "browser_snapshot", args);
    run.devices.request = async function* () {
      yield* [];
      throw new Error("Your computer disconnected. ada-secret");
    } as never;
    const failed = call("browser_snapshot", args);
    await pageBrowserTool(run.ctx, failed);
    expect(failed.finish).toHaveBeenCalledWith({
      error: expect.stringMatching(/^The browser on the user's computer did not finish: /),
    });
    expect(JSON.stringify(failed.finish.mock.calls)).not.toContain("ada-secret");
    run.devices.request = async function* () {
      yield* [];
      throw "gone";
    } as never;
    const plain = call("browser_snapshot", args);
    await pageBrowserTool(run.ctx, plain);
    expect(plain.finish).toHaveBeenCalledWith({
      error: "The browser on the user's computer did not finish: failed",
    });
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    (run.ctx as { context: { signal: AbortSignal } }).context = { signal: stopped.signal };
    await expect(pageBrowserTool(run.ctx, call("browser_snapshot", args))).rejects.toBe("gone");
  });
});

describe("the sign-in", () => {
  it("is held off in every run until the user's browser is offered", async () => {
    const { offerUserBrowser } = await import("./dozo-device-capabilities.js");
    const off = withoutCloudComputerTools(new Set(), false);
    expect(off.has("browser_sign_in")).toBe(true);
    offerUserBrowser(off, []);
    expect(off.has("browser_sign_in")).toBe(false);
    const kept = withoutCloudComputerTools(new Set(), false);
    offerUserBrowser(kept, ["browser_sign_in"]);
    expect(kept.has("browser_sign_in")).toBe(true);
  });

  it("asks once per site in a thread, then tells the bot only whether the user signed in", async () => {
    const run = setup();
    const args = { site: "www.X.com" };
    expect(await userBrowserGate(run.ctx, false, "browser_sign_in", args)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_sign_in", args, [])).toMatchObject({
      text: "Let this bot use its own browser on your computer and have you sign in to x.com?",
    });
    const first = call("browser_sign_in", args);
    run.effects.set(first.effectKey, { id: first.effectKey, request: { ...args } });
    expect(await userBrowserSignIn(run.ctx, first)).toEqual({ site: "x.com", signedIn: true });
    expect(run.requests.at(-1)).toMatchObject({ method: "pageBrowserSignIn", site: "x.com" });
    const again = { site: "x.com" };
    expect(await userBrowserGate(run.ctx, false, "browser_sign_in", again)).toBe("allow");
    run.signIn.answer = false;
    expect(await userBrowserSignIn(run.ctx, call("browser_sign_in", again))).toEqual({
      site: "x.com",
      signedIn: false,
    });
    const elsewhere = { site: "paypa1.com" };
    expect(await userBrowserGate(run.ctx, false, "browser_sign_in", elsewhere)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_sign_in", elsewhere, [])).toMatchObject({
      text: "Let this bot have you sign in to paypa1.com in its browser?",
    });
  });

  it("refuses what its approval did not see, a site it cannot name, and a computer that is gone", async () => {
    const run = setup();
    const unseen = call("browser_sign_in", { site: "x.com" });
    await userBrowserSignIn(run.ctx, unseen);
    expect(unseen.finish.mock.calls[0]![0]).toMatchObject({
      error: expect.stringContaining("not part of this call's approval"),
    });
    allow(run, "signin:");
    const nameless = { site: "not a site" };
    await userBrowserGate(run.ctx, false, "browser_sign_in", nameless);
    const refused = call("browser_sign_in", nameless);
    await userBrowserSignIn(run.ctx, refused);
    expect(refused.finish).toHaveBeenCalledWith({
      error: "Name the site to sign in to, such as x.com.",
    });
    const gone = setup({ capabilities: ["shell"] });
    const away = call("browser_sign_in", { site: "x.com" });
    await userBrowserSignIn(gone.ctx, away);
    expect(away.finish.mock.calls[0]![0]).toMatchObject({
      error: expect.stringContaining("not connected"),
    });
  });

  it("says when the computer did not finish it, and stops with the run", async () => {
    const run = setup();
    allow(run, "signin:x.com");
    const args = { site: "x.com" };
    await userBrowserGate(run.ctx, false, "browser_sign_in", args);
    run.devices.request = async function* () {
      yield* [];
      throw "gone";
    } as never;
    const failed = call("browser_sign_in", args);
    await userBrowserSignIn(run.ctx, failed);
    expect(failed.finish).toHaveBeenCalledWith({
      error: "The user's computer did not finish the sign-in: failed",
    });
    run.devices.request = async function* () {
      yield* [];
      throw new Error("closed");
    } as never;
    const closed = call("browser_sign_in", args);
    await userBrowserSignIn(run.ctx, closed);
    expect(closed.finish).toHaveBeenCalledWith({
      error: "The user's computer did not finish the sign-in: closed",
    });
    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    (run.ctx as { context: { signal: AbortSignal } }).context = { signal: stopped.signal };
    await expect(userBrowserSignIn(run.ctx, call("browser_sign_in", args))).rejects.toThrow(
      "closed",
    );
  });
});
