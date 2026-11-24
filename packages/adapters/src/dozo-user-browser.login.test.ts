import { installAuditEventStore } from "@rakazo/db";
import * as Logging from "@rakazo/logging";
import { afterEach, describe, expect, it, vi } from "vitest";
import { storeBotSecret } from "./bot-secrets.js";
import { accountVault, fakeAuditLog, fakeDatabase } from "./bot-secrets.test-support.js";
import type { DeviceBrowserEvent } from "./dozo-device-browser.js";
import { fakeDeviceBrowser, seededDevicePages } from "./dozo-device-browser.test-support.js";
import { DEVICE_LOGIN_ONLY, encodeDeviceLogin } from "./dozo-device-login.js";
import { pageBrowserTool } from "./dozo-user-browser.js";
import { userBrowserGate } from "./dozo-user-browser-gate.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { EncryptedSecretStore } from "./secrets.js";

vi.mock("./run-tools-computer.js", () => ({
  pageBrowserTool: vi.fn(async () => "the bot's computer"),
}));

afterEach(() => installAuditEventStore(undefined));

const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const FORM = "https://example.test/form";
const SITE = "https://example.test";
const HANDLE = "AbCdEfGhIjKlMnOpQrStUv";
/** What the password manager holds on the computer: nothing here may ever carry it. */
const SENTINEL = "correct-horse-battery-staple-9137";
const context = { operationId: "t", traceId: "t", signal: new AbortController().signal };
const owner = { userId: "user-1", spaceId: "space-1" };

type Fill = {
  method: string;
  botId: string;
  runId: string;
  ref: number;
  origin: string;
  handle: string;
  field: string;
};

/** The user's connected computer with a browser, a vault with a login linked to it, and the audit log. */
async function setup(
  options: {
    capabilities?: string[];
    linkedTo?: string;
    policy?: "ask" | "allow";
    fillError?: string;
    trigger?: string;
  } = {},
) {
  const db = fakeDatabase();
  const audit = fakeAuditLog();
  const link = await secretStore.put(
    encodeDeviceLogin({ deviceId: options.linkedTo ?? "device-1", handle: HANDLE }),
    { ...owner, ...context },
    { recordId: "login-work" },
  );
  await db.prisma.vaultCredential.create({
    data: {
      id: "login-work",
      ...accountVault,
      name: "work",
      origin: SITE,
      auth: { type: "login" },
      ciphertext: link.ciphertext,
      ...(options.policy ? { policy: options.policy } : {}),
    } as never,
  });
  await storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope: owner,
    destination: { name: "plain", origin: SITE, auth: { type: "login" } },
    plaintext: JSON.stringify({
      fields: [{ label: "Password", value: "fake-password-1", hidden: true }],
    }),
  });
  const consents = new Set([
    "bot-1|device-1|thread-1|",
    "bot-1|device-1|thread-1|act:example.test",
    "bot-1|device-1|thread-1|open:example.test",
  ]);
  const device = fakeDeviceBrowser(seededDevicePages);
  const requests: Array<Record<string, unknown>> = [];
  const devices = {
    connected: vi.fn(async () => ({
      deviceId: "device-1",
      name: "Laptop",
      platform: "darwin",
      capabilities: options.capabilities ?? ["shell", "browser", "passwords"],
    })),
    pairedSince: async () => new Date(0),
    async *request(_owner: string, request: Record<string, unknown>) {
      requests.push(request);
      if (request.method === "pageBrowserFillLogin") {
        // The computer reads the value from its own password manager and types it itself.
        if (options.fillError) throw new Error(options.fillError);
        yield { filled: true };
        return;
      }
      if (request.method === "pageBrowserCleared") {
        yield { cleared: false };
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
  const prisma = Object.assign(db.prisma, {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (sql(strings).includes("dozo_token_taints")) return [{ sourced: false }];
      if (sql(strings).includes("FROM dozo_browser_consents"))
        return [...consents]
          .filter((key) => key.startsWith(`${values[0]}|${values[1]}|${values[2]}|`))
          .map((key) => ({ site: key.split("|")[3] }));
      return [{ locked: 1 }];
    }),
    $executeRaw: vi.fn(async () => 1),
    externalEffect: { findUnique: async () => null },
    attempt: { count: async () => 1 },
  });
  const secrets = new Set<string>(["ada-secret"]);
  const ctx = {
    source: { userComputerOwner: "user-1" },
    deps: { userDevices: devices, prisma, secretStore },
    bot: { id: "bot-1", name: "Ada" },
    thread: { id: "thread-1" },
    run: { ...owner, id: "run-1", botId: "bot-1", trigger: options.trigger ?? "user" },
    runId: "run-1",
    context: { signal: new AbortController().signal },
    secrets,
    state: { vaultUses: new Set<string>() } as {
      pageUrl?: string;
      vaultUses: Set<string>;
    },
    trust: { receivedOutsideMessage: async () => false },
    computer: { acceptsImages: false, stored: {}, graphical: false },
    tools: { disabled: new Set<string>() },
  } as unknown as RunContext;
  await device({ method: "Page.navigate", params: { url: FORM } });
  ctx.state.pageUrl = FORM;
  return { ctx, db, audit, device, devices, requests, secrets };
}

let count = 0;
function call(name: string, args: Record<string, unknown>) {
  return {
    name,
    args,
    effectKey: `effect-${++count}`,
    finish: vi.fn(async (result: unknown) => result),
  } as unknown as ToolCall;
}

/** One browser_act call as the executor runs it: its approval first, then the handler. */
async function act(
  run: Awaited<ReturnType<typeof setup>>,
  actions: Array<Record<string, unknown>>,
  extra: Record<string, unknown> = {},
) {
  const args = { actions, ...extra };
  expect(await userBrowserGate(run.ctx, false, "browser_act", args)).toBe("allow");
  return JSON.stringify(await pageBrowserTool(run.ctx, call("browser_act", args)));
}

const fills = (run: Awaited<ReturnType<typeof setup>>) =>
  run.requests.filter((request) => request.method === "pageBrowserFillLogin") as Fill[];
const fill = (secret: string, field: string, ref = "e11") => ({
  kind: "fill_secret",
  ref,
  secret,
  field,
});

describe("a login linked to the user's computer, filled in the browser there", () => {
  it("asks the computer to fill the node on the approved site, and carries no value", async () => {
    const run = await setup();
    const seen = await act(run, [fill("work", "Username", "e11"), fill("work", "Password", "e12")]);
    expect(seen).toContain('\\"ok\\":true');
    expect(fills(run)).toEqual([
      {
        method: "pageBrowserFillLogin",
        botId: "bot-1",
        runId: "run-1",
        ref: 11,
        origin: SITE,
        handle: HANDLE,
        field: "username",
      },
      {
        method: "pageBrowserFillLogin",
        botId: "bot-1",
        runId: "run-1",
        ref: 12,
        origin: SITE,
        handle: HANDLE,
        field: "password",
      },
    ]);
    // The server typed nothing itself, and the model's call kept no key of this browser.
    expect(run.device.value(11)).toBeUndefined();
    expect(run.device.commands.map((command) => command.method)).not.toContain("Input.insertText");
    expect(seen).not.toContain("dozo-device-fill");
    // One use of the item on that site, recorded once for both fields.
    expect(run.ctx.state.vaultUses.size).toBe(1);
  });

  it("fills a code from the same link, and holds no authenticator of its own", async () => {
    const run = await setup();
    const seen = await act(run, [{ kind: "fill_code", ref: "e11", secret: "work" }]);
    expect(seen).toContain('\\"ok\\":true');
    expect(fills(run)).toEqual([expect.objectContaining({ field: "code", handle: HANDLE })]);
  });

  it("keeps the value out of the audit log, the logs, the redaction list and what is stored", async () => {
    const run = await setup();
    const logged = vi.fn();
    const logger = vi
      .spyOn(Logging, "getLogger")
      .mockReturnValue({ warn: logged, info: logged, error: logged, debug: logged } as never);
    const loaded: string[] = [];
    const load = secretStore.load.bind(secretStore);
    const spy = vi.spyOn(secretStore, "load").mockImplementation(async (...args) => {
      const value = await load(...args);
      loaded.push(value);
      return value;
    });
    try {
      const seen = await act(run, [fill("work", "Password")]);
      const everything = JSON.stringify({
        seen,
        requests: run.requests,
        audit: run.audit,
        logged: logged.mock.calls,
        secrets: [...run.secrets],
        stored: run.db.rows(),
        loaded,
      });
      expect(everything).not.toContain(SENTINEL);
      // What the server holds and logs of the use: the item, the site, the handle in the request.
      expect(run.audit).toEqual([
        expect.objectContaining({
          action: "credential.used",
          metadata: expect.not.objectContaining({ value: expect.anything() }),
        }),
      ]);
      expect(JSON.stringify(run.audit)).toContain("example.test");
      // Only the link was ever read back from the vault.
      for (const plaintext of loaded)
        expect(JSON.parse(plaintext)).toEqual({
          deviceLogin: { deviceId: "device-1", handle: HANDLE },
        });
      expect([...run.secrets]).toEqual(["ada-secret"]);
    } finally {
      spy.mockRestore();
      logger.mockRestore();
    }
  });

  it("refuses a login linked to another computer, and sends nothing", async () => {
    const run = await setup({ linkedTo: "device-2" });
    const seen = await act(run, [fill("work", "Password")]);
    expect(seen).toContain(DEVICE_LOGIN_ONLY);
    expect(fills(run)).toEqual([]);
    expect(run.ctx.state.vaultUses.size).toBe(0);
  });

  it("still refuses every other login in the user's browser, as before", async () => {
    const run = await setup();
    expect(await act(run, [fill("plain", "Password")])).toContain(
      "Saved logins are unavailable here.",
    );
    expect(await act(run, [{ kind: "fill_code", ref: "e11", secret: "plain" }])).toContain(
      "Codes are unavailable here.",
    );
    expect(fills(run)).toEqual([]);
    expect(run.secrets).toEqual(new Set(["ada-secret"]));
  });

  it("refuses a login that is not saved", async () => {
    const run = await setup();
    expect(await act(run, [fill("missing", "Password")])).toContain("Login is unavailable.");
    expect(fills(run)).toEqual([]);
  });

  it("is not offered by a computer that did not declare passwords", async () => {
    const run = await setup({ capabilities: ["shell", "browser"] });
    expect(await act(run, [fill("work", "Password")])).toContain(
      "Saved logins are unavailable here.",
    );
    expect(fills(run)).toEqual([]);
  });

  it("turns each answer of the computer into one sentence for the bot", async () => {
    const locked = await setup({ fillError: "passwords-locked" });
    const seen = await act(locked, [fill("work", "Password")]);
    expect(seen).toContain("The password manager is locked or did not approve.");
    expect(seen).toContain('\\"ok\\":false');
    const unknown = await setup({ fillError: "something the manager printed" });
    const other = await act(unknown, [fill("work", "Password")]);
    expect(other).toContain("The user's computer could not fill this login.");
    expect(other).not.toContain("something the manager printed");
  });

  it("does not take a key the model made up for a value", async () => {
    const run = await setup();
    const seen = await act(run, [
      { kind: "fill", ref: "e11", text: "dozo-device-fill:made-up", origin: SITE },
    ]);
    expect(seen).toContain("not available");
    expect(fills(run)).toEqual([]);
  });

  it("types no value of its own into a page when a login fails to resolve", async () => {
    const run = await setup();
    await act(run, [fill("missing", "Password")]);
    expect(run.device.commands.map((command) => command.method)).not.toContain("Input.insertText");
  });
});

describe("a linked login that asks first", () => {
  const approval = (run: Awaited<ReturnType<typeof setup>>, change: object = {}) => ({
    kind: "login",
    login: "work",
    site: SITE,
    title: "",
    fields: ["Password"],
    savedAt: run.db
      .rows()
      .find((row) => row.name === "work")!
      .updatedAt!.toISOString(),
    ...change,
  });

  it("types nothing without the user's approval of this call, on this site, as saved now", async () => {
    const run = await setup({ policy: "ask" });
    for (const given of [
      undefined,
      approval(run, { site: "https://other.test" }),
      approval(run, { fields: ["Username"] }),
      approval(run, { login: "plain" }),
    ])
      expect(
        await act(run, [fill("work", "Password")], given ? { loginApproval: given } : {}),
      ).toContain("not approved");
    expect(fills(run)).toEqual([]);
    expect(run.ctx.state.vaultUses.size).toBe(0);
  });

  it("fills once approved, and records the use", async () => {
    const run = await setup({ policy: "ask" });
    const seen = await act(run, [fill("work", "Password")], { loginApproval: approval(run) });
    expect(seen).toContain('\\"ok\\":true');
    expect(fills(run)).toHaveLength(1);
    expect(run.ctx.state.vaultUses.size).toBe(1);
  });
});
