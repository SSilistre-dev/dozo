import { ORPCError } from "@orpc/server";
import type { PlanLimitBilling, PlanLimitCopy } from "@rakazo/contracts";
import { PLAN_LIMIT_CODES, planLimitNotice, planLimitOf } from "@rakazo/contracts";
import { ComputerLimitError, SharedSpaceFullError, SpaceLimitError } from "@rakazo/db";
import { describe, expect, it } from "vitest";
import { PlanNotOfferedError } from "./dozo-billing.js";
import { handleRpcError } from "./rpc-errors.js";

// Runs on the branded tree only: the codes and the table exist once the brand rules are applied.

/** The clients pass translated copy; here each sentence is its own key, so the pick is visible. */
const copy = new Proxy({} as PlanLimitCopy, {
  get: (_, key) => (key === "upgradeTo" ? (plan: string) => `upgradeTo ${plan}` : String(key)),
});

/** What a client receives for a refusal: the RPC error the server's translation throws. */
function answer(error: Error): ORPCError<string, unknown> {
  try {
    handleRpcError(error, ["test"]);
  } catch (thrown) {
    if (thrown instanceof ORPCError) return thrown;
  }
  throw new Error("no RPC error");
}

const offers = [
  {
    tier: "pro",
    name: "Premium",
    monthlyPriceCents: 4900,
    annualPriceCents: null,
    computerSize: "large",
    computerHours: 100,
  },
  {
    tier: "max",
    name: "Premium Plus",
    monthlyPriceCents: 9900,
    annualPriceCents: null,
    computerSize: "large",
    computerHours: 200,
  },
] satisfies PlanLimitBilling["byokTiers"];
const free: PlanLimitBilling = {
  canManage: true,
  byokTier: "standard",
  byokTiers: offers,
  funding: "byok",
  state: "none",
};
const member: PlanLimitBilling = { ...free, canManage: false };

describe("a server refusal reaches the client with its stable code and maps to a notice", () => {
  it("shared space full: Upgrade for the owner, ask the owner for a member", () => {
    const sent = answer(new SharedSpaceFullError());
    expect(sent.code).toBe(PLAN_LIMIT_CODES.sharedSpaceFull);
    const limit = planLimitOf(sent);
    expect(limit).toBe("shared_space_full");
    expect(planLimitNotice(limit ?? "shared_space_full", free, copy)).toEqual({
      code: "shared_space_full",
      text: "sharedSpaceFullUpgrade",
      action: { kind: "upgrade", label: "upgrade", startsPaidPlan: true },
    });
    expect(planLimitNotice("shared_space_full", member, copy)).toEqual({
      code: "shared_space_full",
      text: "sharedSpaceFullAskOwner",
      action: null,
    });
  });

  it("Space count: its own code and sentence, no upgrade (the limit is not a plan's)", () => {
    const sent = answer(new SpaceLimitError());
    // Upstream's client-error-mapping test expects code BAD_REQUEST; here only the code differs.
    expect(sent.code).toBe(PLAN_LIMIT_CODES.spaceLimit);
    expect(sent.status).toBe(400);
    expect(sent.message).toBe("Space limit reached");
    expect(planLimitNotice(planLimitOf(sent) ?? "computer_hours", free, copy)).toEqual({
      code: "space_limit_reached",
      text: "spaceLimit",
      action: null,
    });
  });

  it("per-user computers: its own code and sentence, no upgrade", () => {
    const sent = answer(new ComputerLimitError(3));
    expect(sent.code).toBe(PLAN_LIMIT_CODES.computerLimit);
    expect(sent.status).toBe(400);
    expect(sent.message).toBe("User computer limit (3) reached");
    expect(planLimitNotice(planLimitOf(sent) ?? "computer_hours", free, copy)).toEqual({
      code: "computer_limit_reached",
      text: "computerLimit",
      action: null,
    });
  });

  it("a checkout of the free plan: a plain sentence, no action", () => {
    const sent = answer(new PlanNotOfferedError());
    expect(sent.code).toBe(PLAN_LIMIT_CODES.planNotOffered);
    expect(planLimitNotice(planLimitOf(sent) ?? "computer_hours", free, copy)).toEqual({
      code: "plan_not_offered",
      text: "planNotOffered",
      action: null,
    });
  });
});
