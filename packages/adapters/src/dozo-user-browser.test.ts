import { beforeEach, describe, expect, it, vi } from "vitest";

const withheld = vi.hoisted(() => ({ value: false }));
vi.mock("./run-tools-computer.js", () => ({
  pageBrowserTool: vi.fn(async () => "the bot's computer"),
}));
vi.mock("./dozo-no-computer.js", () => ({
  filesWithoutComputer: () => (withheld.value ? { error: "none" } : undefined),
}));

import type { DeviceBrowserEvent } from "./dozo-device-browser.js";
import { fakeDeviceBrowser, seededDevicePages } from "./dozo-device-browser.test-support.js";
import { pageBrowserTool, USER_BROWSER_NOTE } from "./dozo-user-browser.js";
import { pageSite, routesToUserBrowser, userBrowserGate } from "./dozo-user-browser-gate.js";
import { buildApprovalAskBlock } from "./dozo-user-computer-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

const FORM = "https://example.test/form";

/** A run with the user's computer connected, a consent table, effects and a token mark, in memory. */
function setup(options: { capabilities?: string[]; owner?: string; token?: boolean } = {}) {
  const consents = new Set<string>();
  const effects = new Map<string, { id: string; request: unknown }>();
  const device = fakeDeviceBrowser(seededDevicePages);
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
    state: {} as { pageUrl?: string },
    computer: { acceptsImages: true, stored: {}, graphical: false },
    tools: { disabled: new Set<string>() },
  } as unknown as RunContext;
  return { ctx, consents, effects, device, requests, devices };
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

  it("asks once per thread for the browser, then once per site it opens, reads or acts on", async () => {
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
      new Set(["bot-1|device-1|thread-1|", "bot-1|device-1|thread-1|example.test"]),
    );
    // The site it was allowed: looking, acting and opening it again go ahead.
    expect(await userBrowserGate(ctx, false, "browser_snapshot", {})).toBe("allow");
    expect(await userBrowserGate(ctx, false, "browser_act", { actions: [] })).toBe("allow");
    expect(await userBrowserGate(ctx, false, "browser_navigate", { url: FORM })).toBe("allow");
    // Another site asks, naming it.
    const other = { url: "https://www.other.test/?d=secret" };
    expect(await userBrowserGate(ctx, false, "browser_navigate", other)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_navigate", other, [])).toMatchObject({
      text: "Let this bot open other.test in its browser?",
    });
    // Another thread asks again from the start.
    (ctx as { thread: { id: string } }).thread = { id: "thread-2" };
    const look = {};
    expect(await userBrowserGate(ctx, false, "browser_snapshot", look)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_snapshot", look, [])).toMatchObject({
      text: "Let this bot use its own browser on your computer?",
    });
    expect(buildApprovalAskBlock("e", "browser_snapshot", look, [])).not.toHaveProperty("detail");
  });

  it("names the site it reads or acts on from the browser, or this page when it cannot tell", async () => {
    const run = setup();
    await approved(run, "browser_navigate", { url: FORM });
    run.consents.delete("bot-1|device-1|thread-1|example.test");
    const look = {};
    expect(await userBrowserGate(run.ctx, false, "browser_snapshot", look)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_snapshot", look, [])).toMatchObject({
      text: "Let this bot read example.test in its browser?",
    });
    const act = { actions: [{ kind: "fill", ref: "e11", text: "ada-secret" }] };
    expect(await userBrowserGate(run.ctx, false, "browser_act", act)).toBe("ask");
    const card = buildApprovalAskBlock("e", "browser_act", act, ["ada-secret"]);
    expect(card).toMatchObject({ text: "Let this bot act on example.test in its browser?" });
    expect((card as { detail: string }).detail).not.toContain("ada-secret");
    run.devices.request = async function* () {
      yield* [];
      throw new Error("the browser closed");
    } as never;
    const unknown = { actions: [] };
    expect(await userBrowserGate(run.ctx, false, "browser_act", unknown)).toBe("ask");
    expect(buildApprovalAskBlock("e", "browser_act", unknown, [])).toMatchObject({
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
