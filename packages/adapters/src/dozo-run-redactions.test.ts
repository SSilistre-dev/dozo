import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadRunRedactions } from "./dozo-run-redactions.js";

// The one list of what a run hides, which a run's assembly (run-assembly-records.ts, through the
// fork's rules) and a learning review both load.

const calls = vi.hoisted(() => [] as unknown[][]);

vi.mock("./secrets/bot-secrets.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./secrets/bot-secrets.js")>()),
  loadCommandVariables: async (_p: unknown, _s: unknown, scope: unknown) => {
    calls.push(["command", scope]);
    return { env: { API_KEY: "sk-variable" }, used: [], redactions: ["sk-variable"] };
  },
  loadLoginPasswordRedactions: async (_p: unknown, _s: unknown, scope: unknown) => {
    calls.push(["login", scope]);
    return ["saved-login-pass"];
  },
  loadRunLoginRedactions: async (_p: unknown, _s: unknown, scope: unknown, runId: string) => {
    calls.push(["run-login", scope, runId]);
    return [`login-of-${runId}`];
  },
  loadRunCodeRedactions: async (_p: unknown, _s: unknown, scope: unknown, runId: string) => {
    calls.push(["run-code", scope, runId]);
    return [`code-of-${runId}`];
  },
}));
vi.mock("./payments/purchase-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./payments/purchase-service.js")>()),
  loadPurchaseRedactions: async (_deps: unknown, scope: unknown) => {
    calls.push(["purchase", scope]);
    return ["4242424242424242"];
  },
}));

const scope = { userId: "owner", spaceId: "space-1", botId: "bot-1" };
const deps = (paymentWallet: unknown) =>
  ({ prisma: {}, secretStore: { load: vi.fn() }, paymentWallet }) as never;

beforeEach(() => {
  calls.length = 0;
});

describe("loadRunRedactions", () => {
  it("loads every kind a run hides, in the order a run adds them", async () => {
    const loaded = await loadRunRedactions(deps({}), scope, ["r1", "r2"]);
    expect(loaded.commands).toEqual({
      env: { API_KEY: "sk-variable" },
      used: [],
      redactions: ["sk-variable"],
    });
    expect(loaded.saved).toEqual([
      "saved-login-pass",
      "4242424242424242",
      "login-of-r1",
      "login-of-r2",
      "code-of-r1",
      "code-of-r2",
    ]);
    // Each loader gets the scope it was given, unchanged, and each run its own id.
    for (const call of calls) expect(call[1]).toBe(scope);
    expect(
      calls
        .filter((call) => call.length === 3)
        .map((call) => call.slice(0, 1).concat(call[2] as string)),
    ).toEqual([
      ["run-login", "r1"],
      ["run-login", "r2"],
      ["run-code", "r1"],
      ["run-code", "r2"],
    ]);
  });

  it("reads no purchases without a payment wallet, as a run does", async () => {
    for (const wallet of [null, undefined]) {
      const loaded = await loadRunRedactions(deps(wallet), scope, ["r1"]);
      expect(loaded.saved).toEqual(["saved-login-pass", "login-of-r1", "code-of-r1"]);
    }
    expect(calls.some((call) => call[0] === "purchase")).toBe(false);
  });
});
