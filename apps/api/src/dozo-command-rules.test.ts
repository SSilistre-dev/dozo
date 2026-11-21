import { describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
  list: vi.fn(async () => [{ id: "rule-1" }]),
  words: vi.fn(async (): Promise<string[] | undefined> => ["git", "status"]),
  update: vi.fn(async () => undefined),
  remove: vi.fn(async () => undefined),
  hasComputer: vi.fn(async () => true),
  readAsks: vi.fn(async () => false),
  saveAsks: vi.fn(async () => undefined),
}));
vi.mock("@rakazo/db", () => ({
  listDozoCommandRules: db.list,
  findDozoCommandRuleWords: db.words,
  updateDozoCommandRule: db.update,
  removeDozoCommandRule: db.remove,
  dozoSpaceHasComputer: db.hasComputer,
  readDozoHostedAsks: db.readAsks,
  saveDozoHostedAsks: db.saveAsks,
}));

import {
  CommandPrefixNotAllowedError,
  CommandRuleNotFoundError,
  dozoCommandRulesRoutes,
} from "./dozo-command-rules.js";
import type { RouterContext } from "./routes/context.js";

type Handler = (options: { context: unknown; input?: unknown }) => Promise<unknown>;

describe("dozoCommandRulesRoutes", () => {
  const procedure = { handler: (fn: Handler) => fn };
  const ctx = {
    deps: { prisma: "prisma" },
    authed: {
      dozoCommandRules: {
        list: procedure,
        update: procedure,
        remove: procedure,
        getHostedAsks: procedure,
        setHostedAsks: procedure,
      },
    },
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

  it("changes what one of the member's own rules does", async () => {
    const input = { id: "rule-1", effect: "allow_prefix" };
    expect(await routes.update!({ context: { actor }, input })).toEqual({ ok: true });
    expect(db.words).toHaveBeenCalledWith("prisma", actor, "rule-1");
    expect(db.update).toHaveBeenCalledWith("prisma", actor, "rule-1", "allow_prefix");
  });

  it("refuses a rule the member does not have, another member's included", async () => {
    db.words.mockResolvedValueOnce(undefined);
    db.update.mockClear();
    await expect(
      routes.update!({ context: { actor }, input: { id: "theirs", effect: "allow" } }),
    ).rejects.toBeInstanceOf(CommandRuleNotFoundError);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("refuses any arguments after a program that runs others, or a program alone", async () => {
    db.update.mockClear();
    for (const words of [["bash", "-c"], ["git"]]) {
      db.words.mockResolvedValueOnce(words);
      await expect(
        routes.update!({ context: { actor }, input: { id: "rule-1", effect: "allow_prefix" } }),
      ).rejects.toBeInstanceOf(CommandPrefixNotAllowedError);
    }
    db.words.mockResolvedValueOnce(["bash", "-c"]);
    await routes.update!({ context: { actor }, input: { id: "rule-1", effect: "block" } });
    expect(db.update).toHaveBeenCalledTimes(1);
  });

  it("reads and saves whether the bot's computer asks, null where the Space has none", async () => {
    expect(await routes.getHostedAsks!({ context: { actor } })).toEqual({ hostedAsks: false });
    expect(db.readAsks).toHaveBeenCalledWith("prisma", "user-1");
    db.readAsks.mockResolvedValueOnce(true);
    expect(
      await routes.setHostedAsks!({ context: { actor }, input: { hostedAsks: true } }),
    ).toEqual({ hostedAsks: true });
    expect(db.saveAsks).toHaveBeenCalledWith("prisma", "user-1", true);
    db.hasComputer.mockResolvedValueOnce(false);
    expect(await routes.getHostedAsks!({ context: { actor } })).toEqual({ hostedAsks: null });
  });
});
