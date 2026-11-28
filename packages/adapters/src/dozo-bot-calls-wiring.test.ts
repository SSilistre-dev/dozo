import { readFileSync } from "node:fs";
import { expect, it, vi } from "vitest";

// Runs on the branded tree only: upstream's code reaches the policy through anchored rules.

const policy = vi.hoisted(() => ({
  request: vi.fn(async (..._args: unknown[]) => ({ error: "from the policy" })),
}));
vi.mock("./dozo-bot-calls.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-bot-calls.js")>()),
  dozoRequestUserCall: policy.request,
}));

import { messagingTools } from "./runs/tools/run-tools-messaging.js";

it("sends every call_user through the policy, with the executor's own deps and run", async () => {
  const deps = { prisma: {} };
  const run = { id: "run-1", trigger: "routine" };
  const ctx = {
    deps,
    run,
    thread: { groupId: null },
    source: { messagingChannelRun: false, voiceCall: false },
  };
  const call = { args: { reason: "Server down", opening: "It is down." }, finish: (x: unknown) => x };
  expect(await messagingTools.call_user!(ctx as never, call as never)).toEqual({
    error: "from the policy",
  });
  expect(policy.request).toHaveBeenCalledWith(deps, run, {
    reason: "Server down",
    opening: "It is down.",
  });
});

it("offers the tool through the policy and gives a routine's tool its guidance", () => {
  const assembly = readFileSync(
    new URL("./runs/assembly/run-assembly-capabilities.ts", import.meta.url),
    "utf8",
  );
  expect(assembly).toContain("(await dozoMayOfferCall(deps, run)) &&");
  expect(assembly).toContain(".map(dozoCallToolFor(run.trigger))");
});
