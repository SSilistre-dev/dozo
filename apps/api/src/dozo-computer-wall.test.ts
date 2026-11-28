import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { dozoComputerWallRoutes, listComputerTiles } from "./dozo-computer-wall.js";
import type { RouterContext } from "./routes/context.js";

const actor: Actor = { userId: "user-1", spaceId: "space-1", email: "a@example.test" } as Actor;
const computer = (fields: Record<string, unknown> = {}) => ({
  kind: "fake",
  state: "running",
  scope: "dedicated",
  controlHolder: "none",
  homeRevision: "empty",
  maintenanceId: null,
  providerRef: "ref-1",
  ...fields,
});

function fakePrisma(bots: Array<{ id: string; computer: ReturnType<typeof computer> | null }>) {
  const findMany = vi.fn(async () => bots);
  return { prisma: { bot: { findMany } } as never, findMany };
}

it("reads only the caller's Space, and only bots that have a computer", async () => {
  const { prisma, findMany } = fakePrisma([]);
  await listComputerTiles(prisma, actor);
  expect(findMany).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space-1", archivedAt: null, computerId: { not: null } },
    }),
  );
});

it("offers a screen only for a computer running now with one to show", async () => {
  const { prisma } = fakePrisma([
    { id: "running", computer: computer() },
    { id: "falling-asleep", computer: computer({ state: "suspending" }) },
    { id: "asleep", computer: computer({ state: "suspended", providerRef: null }) },
    { id: "updating", computer: computer({ maintenanceId: "m-1" }) },
    { id: "no-ref", computer: computer({ providerRef: null }) },
    { id: "own-machine", computer: computer({ kind: "desktop" }) },
    { id: "gone", computer: null },
  ]);
  expect(await listComputerTiles(prisma, actor)).toEqual([
    { botId: "running", state: "running", screen: true },
    { botId: "falling-asleep", state: "running", screen: false },
    { botId: "asleep", state: "suspended", screen: false },
    { botId: "updating", state: "booting", screen: false },
    { botId: "no-ref", state: "running", screen: false },
    { botId: "own-machine", state: "running", screen: false },
  ]);
});

it("answers the list procedure for the signed-in caller", async () => {
  const { prisma, findMany } = fakePrisma([{ id: "bot-1", computer: computer() }]);
  const ctx = {
    deps: { prisma },
    authed: { dozoComputerWall: { list: { handler: (fn: unknown) => fn } } },
  } as unknown as RouterContext;
  const list = dozoComputerWallRoutes(ctx).dozoComputerWall.list as unknown as (call: {
    context: { actor: Actor };
  }) => Promise<unknown>;
  await expect(list({ context: { actor } })).resolves.toEqual([
    { botId: "bot-1", state: "running", screen: true },
  ]);
  expect(findMany).toHaveBeenCalledOnce();
});
