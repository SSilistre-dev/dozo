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

/** A run with the user's computer connected, a consent table and a token mark, all in memory. */
function setup(options: { capabilities?: string[]; owner?: string; token?: boolean } = {}) {
  const consents = new Set<string>();
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
          .filter((key) => key.startsWith(`${values[0]}|${values[1]}|`))
          .map((key) => ({ site: key.split("|")[2] }));
      throw new Error(`unexpected SQL ${sql(strings)}`);
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (!sql(strings).includes("INSERT INTO dozo_browser_consents"))
        throw new Error("unexpected");
      consents.add(values.join("|"));
      return 1;
    }),
  };
  const ctx = {
    source: { userComputerOwner: "owner" in options ? options.owner : "user-1" },
    deps: { userDevices: devices, prisma },
    bot: { id: "bot-1" },
    run: { botId: "bot-1", threadId: "thread-1", userId: "user-1" },
    runId: "run-1",
    context: { signal: new AbortController().signal },
    secrets: new Set<string>(["ada-secret"]),
    state: {} as { pageUrl?: string },
    computer: { acceptsImages: true, stored: {}, graphical: false },
    tools: { disabled: new Set<string>() },
  } as unknown as RunContext;
  return { ctx, consents, device, requests, devices };
}

function call(name: string, args: Record<string, unknown>) {
  return {
    name,
    args,
    finish: vi.fn(async (result: unknown) => result),
  } as unknown as ToolCall & { finish: ReturnType<typeof vi.fn> };
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

  it("asks once per bot and computer, then once per site acted on", async () => {
    const { ctx, devices } = setup();
    const first = { url: FORM };
    expect(await userBrowserGate(ctx, false, "browser_navigate", first)).toBe("ask");
    const card = buildApprovalAskBlock("effect-1", "browser_navigate", first, []);
    expect(card).toMatchObject({
      kind: "ask",
      text: "Let this bot use its own browser on your computer?",
      detail: FORM,
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    // The person allowed it: the call runs, and the browser is allowed from then on.
    await pageBrowserTool(ctx, call("browser_navigate", first));
    expect(await userBrowserGate(ctx, false, "browser_snapshot", {})).toBe("allow");
    expect(await userBrowserGate(ctx, false, "browser_navigate", { url: FORM })).toBe("allow");

    const act = { actions: [{ kind: "fill", ref: "e11", text: "ada-secret" }] };
    // The site is read from the browser itself, which shows the form now.
    expect(await userBrowserGate(ctx, false, "browser_act", act)).toBe("ask");
    const actCard = buildApprovalAskBlock("effect-2", "browser_act", act, ["ada-secret"]);
    expect(actCard).toMatchObject({ text: "Let this bot act on example.test in its browser?" });
    expect((actCard as { detail: string }).detail).not.toContain("ada-secret");
    await pageBrowserTool(ctx, call("browser_act", act));
    expect(await userBrowserGate(ctx, false, "browser_act", { actions: [] })).toBe("allow");

    const unknown = { actions: [] };
    devices.request = async function* () {
      yield* [];
      throw new Error("the browser closed");
    } as never;
    expect(await userBrowserGate(ctx, false, "browser_act", unknown)).toBe("ask");
    expect(buildApprovalAskBlock("effect-3", "browser_act", unknown, [])).toMatchObject({
      text: "Let this bot act on this page in its browser?",
    });
  });

  it("asks about the browser alone before it is allowed, without starting it", async () => {
    const { ctx, requests } = setup();
    const act = { actions: [{ kind: "click", ref: "e12" }] };
    expect(await userBrowserGate(ctx, false, "browser_act", act)).toBe("ask");
    expect(buildApprovalAskBlock("effect-5", "browser_act", act, [])).toMatchObject({
      text: "Let this bot use its own browser on your computer?",
    });
    expect(requests).toHaveLength(0);
  });

  it("runs an approved call only on the computer it asked about", async () => {
    const { ctx, devices } = setup();
    const args = { url: FORM };
    await userBrowserGate(ctx, false, "browser_navigate", args);
    devices.connected.mockResolvedValue({
      deviceId: "device-2",
      name: "Other",
      platform: "linux",
      capabilities: ["shell", "browser"],
    } as never);
    const moved = call("browser_navigate", args);
    await pageBrowserTool(ctx, moved);
    expect(moved.finish).toHaveBeenCalledWith({
      error: "The user's computer changed since this was approved. Try again.",
    });
  });

  it("asks when the computer went away between the offer and the call", async () => {
    const { ctx, devices } = setup();
    devices.connected.mockResolvedValueOnce(null as never);
    expect(await userBrowserGate(ctx, false, "browser_snapshot", {})).toBe("ask");
  });
});

describe("its handler", () => {
  it("provisions the bot there, drives the page and says once where the browser is", async () => {
    const { ctx, requests } = setup();
    const navigated = (await pageBrowserTool(ctx, call("browser_navigate", { url: FORM }))) as {
      kind: string;
      details: { url: string; note: string };
    };
    expect(navigated.details).toMatchObject({ url: FORM, note: USER_BROWSER_NOTE });
    expect(ctx.state.pageUrl).toBe(FORM);
    expect(requests[0]).toMatchObject({ method: "provision", botId: "bot-1" });
    const again = (await pageBrowserTool(ctx, call("browser_navigate", { url: FORM }))) as {
      details: { note?: string };
    };
    expect(again.details.note).toBeUndefined();
  });

  it("shows a model that can see what the page looks like", async () => {
    const { ctx } = setup();
    await pageBrowserTool(ctx, call("browser_navigate", { url: FORM }));
    const looked = (await pageBrowserTool(ctx, call("browser_snapshot", {}))) as {
      content: Array<{ type: string; data?: string }>;
    };
    expect(looked.content.at(-1)).toEqual({
      type: "image",
      data: "c2NyZWVu",
      mimeType: "image/jpeg",
    });
    (ctx.computer as { acceptsImages: boolean }).acceptsImages = false;
    const blind = (await pageBrowserTool(ctx, call("browser_snapshot", {}))) as {
      content: Array<{ type: string }>;
    };
    expect(blind.content.map((part) => part.type)).toEqual(["text"]);
  });

  it("hides the run's secrets in what the page shows", async () => {
    const { ctx } = setup();
    await pageBrowserTool(ctx, call("browser_navigate", { url: FORM }));
    const acted = (await pageBrowserTool(
      ctx,
      call("browser_act", { actions: [{ kind: "fill", ref: "e11", text: "ada-secret" }] }),
    )) as { content: Array<{ text: string }> };
    expect(acted.content[0]!.text).not.toContain("ada-secret");
  });

  it("refuses a run a token's message reached, even past the gate", async () => {
    const { ctx, requests } = setup({ token: true });
    const refused = call("browser_snapshot", {});
    await pageBrowserTool(ctx, refused);
    expect(refused.finish).toHaveBeenCalledWith({
      error: "The browser on the user's computer is not used for a message sent with a token.",
    });
    expect(requests).toHaveLength(0);
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

  it("says when the computer did not finish", async () => {
    const { ctx, devices } = setup();
    devices.request = async function* () {
      yield* [];
      throw new Error("Your computer disconnected. ada-secret");
    } as never;
    const failed = call("browser_snapshot", {});
    await pageBrowserTool(ctx, failed);
    expect(failed.finish).toHaveBeenCalledWith({
      error: expect.stringMatching(/^The browser on the user's computer did not finish: /),
    });
    expect(JSON.stringify(failed.finish.mock.calls)).not.toContain("ada-secret");
  });

  it("keeps the text when the screenshot fails, and stops with the run", async () => {
    const { ctx, devices } = setup();
    await pageBrowserTool(ctx, call("browser_navigate", { url: FORM }));
    const request = devices.request;
    devices.request = async function* (
      owner: string,
      req: { method: string; command?: { method: string } },
    ) {
      if (req.command?.method === "Page.captureScreenshot") throw "no picture";
      yield* request(owner, req as never);
    } as never;
    const looked = (await pageBrowserTool(ctx, call("browser_snapshot", {}))) as {
      content: Array<{ type: string }>;
    };
    expect(looked.content.map((part) => part.type)).toEqual(["text"]);

    const stopped = new AbortController();
    stopped.abort(new Error("stopped"));
    (ctx as { context: { signal: AbortSignal } }).context = { signal: stopped.signal };
    devices.request = async function* () {
      yield* [];
      throw "gone";
    } as never;
    await expect(pageBrowserTool(ctx, call("browser_snapshot", {}))).rejects.toBe("gone");
  });

  it("says what failed when the computer answers with something that is not an error", async () => {
    const { ctx, devices } = setup();
    devices.request = async function* () {
      yield* [];
      throw "gone";
    } as never;
    const failed = call("browser_snapshot", {});
    await pageBrowserTool(ctx, failed);
    expect(failed.finish).toHaveBeenCalledWith({
      error: "The browser on the user's computer did not finish: failed",
    });
  });

  it("asks before the first look with a card that has nothing to show", async () => {
    const { ctx } = setup();
    const args = {};
    expect(await userBrowserGate(ctx, false, "browser_snapshot", args)).toBe("ask");
    const card = buildApprovalAskBlock("effect-4", "browser_snapshot", args, []);
    expect(card).toMatchObject({ text: "Let this bot use its own browser on your computer?" });
    expect(card).not.toHaveProperty("detail");
  });
});
