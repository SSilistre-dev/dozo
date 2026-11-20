import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: "rule-1" }]),
  remove: vi.fn(async () => undefined),
}));
vi.mock("@rakazo/db", () => ({
  listDozoCommandRules: db.list,
  removeDozoCommandRule: db.remove,
}));

import { dozoCommandRulesRoutes } from "./dozo-command-rules.js";
import type { RouterContext } from "./routes/context.js";

type Handler = (options: { context: unknown; input?: unknown }) => Promise<unknown>;

describe("dozoCommandRulesRoutes", () => {
  const procedure = { handler: (fn: Handler) => fn };
  const ctx = {
    deps: { prisma: "prisma" },
    authed: { dozoCommandRules: { list: procedure, remove: procedure } },
  } as unknown as RouterContext;
  const routes = dozoCommandRulesRoutes(ctx).dozoCommandRules as unknown as Record<string, Handler>;
  const actor = { userId: "user-1", spaceId: "space-1" };

  it("lists and removes the signed-in member's rules in the current Space", async () => {
    expect(await routes.list!({ context: { actor } })).toEqual([{ id: "rule-1" }]);
    expect(db.list).toHaveBeenCalledWith("prisma", actor);
    expect(await routes.remove!({ context: { actor }, input: { id: "rule-1" } })).toEqual({
      ok: true,
    });
    expect(db.remove).toHaveBeenCalledWith("prisma", actor, "rule-1");
  });
});
