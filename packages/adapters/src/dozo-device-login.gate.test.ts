import type * as Core from "@rakazo/core";
import { approvalCardExpires } from "@rakazo/core";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { encodeDeviceLogin } from "./dozo-device-login.js";
import { gateToolCall } from "./runs/tools/run-tool-gate.js";
import type { ToolRequest } from "./runs/tools/run-tool-request.js";
import { prepareToolRequest } from "./runs/tools/run-tool-request.js";
import { accountVault, fakeDatabase } from "./secrets/bot-secrets.test-support.js";
import { EncryptedSecretStore } from "./secrets/secrets.js";

const plans = vi.hoisted(() => [] as string[]);
vi.mock("@rakazo/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    planActionGate: (input: Parameters<typeof core.planActionGate>[0]) => {
      const plan = core.planActionGate(input);
      plans.push(plan);
      return plan;
    },
  };
});
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof Db>()),
  recordAuditEvent: vi.fn(async () => {}),
}));
// Recording the effect a person answers is where an ask begins; the test stops there.
vi.mock("./runs/lifecycle/run-effects.js", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  recordEffect: vi.fn(async () => {
    throw new Error("asks the user");
  }),
}));

const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const owner = { userId: "user-1", spaceId: "space-1" };
const SITE = "https://login.example.test";
const main = JSON.stringify(["pi-tool", "main", "call-1"]);

/** A login linked to a computer, as the vault keeps it, and the call that fills it. */
async function gate(options: { policy: "ask" | "allow"; trigger?: string; neverAsk?: boolean }) {
  const db = fakeDatabase();
  const { ciphertext } = await secretStore.put(
    encodeDeviceLogin({ deviceId: "device-1", handle: "AbCdEfGhIjKlMnOpQrStUv" }),
    { ...owner, operationId: "t", traceId: "t", signal: new AbortController().signal },
    { recordId: "login-work" },
  );
  await db.prisma.vaultCredential.create({
    data: {
      id: "login-work",
      ...accountVault,
      name: "work",
      origin: SITE,
      auth: { type: "login" },
      ciphertext,
      policy: options.policy,
    } as never,
  });
  Object.assign(db.prisma.secret, { findFirst: async () => null });
  const actions = [{ kind: "fill_secret", ref: "e1", secret: "work", field: "Password" }];
  const request: ToolRequest = {
    name: "browser_act",
    args: { actions },
    executionId: main,
    connectorCall: { tool: "browser_act", args: { actions }, executionId: main, route: undefined },
    effectRequest: undefined,
    resolvedTool: undefined,
    catalogRemapped: false,
    nextApprovedTool: undefined,
    approvedEffectKey: undefined,
    replayEffectToolName: "browser_act",
    fleetSummary: undefined,
    heldForApproval: false,
    purchase: undefined,
    cardUse: undefined,
    settingsChange: false,
    ignoresAllowRules: false,
    loginUse: undefined,
  };
  const ctx = {
    deps: { prisma: db.prisma, secretStore },
    run: {
      ...owner,
      botId: "bot-1",
      id: "run-1",
      trigger: options.trigger ?? "user",
      threadId: "thread-1",
    },
    runId: "run-1",
    bot: { id: "bot-1", name: "Helper" },
    thread: { id: "thread-1" },
    context: { signal: new AbortController().signal },
    source: { ownerStartedRun: true },
    providers: { browser: {} },
    computer: { pageBrowserAllowed: false, heldForTakeover: false },
    tools: { connector: new Map(), connectedPlugins: [] },
    secrets: [],
    state: {
      tainted: false,
      walletHosts: new Set<string>(),
      effects: { consumedIds: new Set(), counts: new Map(), occurrences: [] },
    },
    trust: {
      loadApprovalRules: async () => [],
      loadAutoReviewPreference: async () => ({
        enabled: false,
        skipApprovals: Boolean(options.neverAsk),
      }),
    },
  };
  expect(await prepareToolRequest(ctx as never, request)).toBeUndefined();
  const outcome = await gateToolCall(ctx as never, request, undefined).then(
    (result) => result,
    (error: Error) => error.message,
  );
  return { request, outcome };
}

describe("the vault's approval of a login linked to a computer, through the real gate", () => {
  beforeEach(() => {
    plans.length = 0;
  });

  it("asks the user every time it is set to ask first, in every mode", async () => {
    for (const neverAsk of [false, true]) {
      plans.length = 0;
      const { request, outcome } = await gate({ policy: "ask", neverAsk });
      expect(request.loginUse).toMatchObject({ kind: "login", login: "work", site: SITE });
      expect(request.args).toMatchObject({ loginApproval: request.loginUse });
      expect(outcome).toBe("asks the user");
      expect(plans).toEqual(["ask"]);
    }
  });

  it("asks in a run nobody is watching, such as a webhook's, and the card expires unanswered", async () => {
    // Upstream no longer refuses it: the sign-in waits for a card that ends after 30 minutes, and
    // nothing is filled meanwhile (approvalCardExpires, expireApprovalCard).
    const { outcome } = await gate({ policy: "ask", trigger: "webhook" });
    expect(outcome).toBe("asks the user");
    expect(plans).toEqual(["ask"]);
    expect(approvalCardExpires("webhook")).toBe(true);
  });

  it("asks nothing more than for any login when it is set to allow", async () => {
    const { request } = await gate({ policy: "allow", neverAsk: true });
    expect(request.loginUse).toBeUndefined();
    expect(plans).toEqual(["allow"]);
  });
});
