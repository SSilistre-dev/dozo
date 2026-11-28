import type { Actor } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { dozoComputerWallRoutes, listComputerTiles, wallScreen } from "./dozo-computer-wall.js";
import type { RouterContext } from "./routes/context.js";

const actor: Actor = { userId: "user-1", spaceId: "space-1", email: "a@example.test" } as Actor;
const computer = (fields: Record<string, unknown> = {}) => ({
  id: "computer-1",
  homeKey: "home-1",
  kind: "docker",
  state: "running",
  scope: "dedicated",
  controlHolder: "none",
  controlLeaseId: null,
  homeRevision: "empty",
  maintenanceId: null,
  providerRef: "ref-1",
  screenGeneration: 0,
  ...fields,
});
type Row = { id: string; userId?: string; computer: ReturnType<typeof computer> | null };
const own = (id: string, fields: Record<string, unknown> = {}): Row => ({
  id,
  userId: "user-1",
  computer: computer(fields),
});

function fakePrisma(bots: Row[]) {
  const findMany = vi.fn(async () => bots.map((bot) => ({ userId: "user-1", ...bot })));
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

it("offers a screen only for the caller's own computer, running now, of a kind that watches without waking", async () => {
  const { prisma } = fakePrisma([
    own("running"),
    { id: "member", userId: "user-2", computer: computer() },
    own("falling-asleep", { state: "suspending" }),
    own("asleep", { state: "suspended", providerRef: null }),
    own("updating", { maintenanceId: "m-1" }),
    own("no-ref", { providerRef: null }),
    own("own-machine", { kind: "desktop" }),
    own("wakes", { kind: "boat" }),
    { id: "gone", computer: null },
  ]);
  expect(await listComputerTiles(prisma, actor)).toEqual([
    { botId: "running", state: "running", screen: true },
    { botId: "member", state: "running", screen: false },
    { botId: "falling-asleep", state: "running", screen: false },
    { botId: "asleep", state: "suspended", screen: false },
    { botId: "updating", state: "booting", screen: false },
    { botId: "no-ref", state: "running", screen: false },
    { botId: "own-machine", state: "running", screen: false },
    { botId: "wakes", state: "running", screen: false },
  ]);
});

function screenCtx(bot: Row, session: unknown = { url: "http://sandbox.internal/screen" }) {
  const connectScreen = vi.fn(async () => {
    if (session instanceof Error) throw session;
    return session;
  });
  const sandbox = { connectScreen, keepAlive: vi.fn(), start: vi.fn(), resume: vi.fn() };
  const enqueue = vi.fn();
  const ctx = {
    deps: {
      sandbox,
      jobs: { enqueue },
      env: { screenProxySecret: "fake-test-secret", webOrigin: "https://app.example.test" },
    },
    repos: { getBot: vi.fn(async () => ({ userId: "user-1", screenGeneration: 0, ...bot })) },
  } as unknown as RouterContext;
  return { ctx, connectScreen, sandbox, enqueue };
}

it("watches view-only, without control, wake or sleep change, even a screen the caller controls", async () => {
  const { ctx, connectScreen, sandbox, enqueue } = screenCtx(
    own("bot-1", { controlHolder: "user", controlLeaseId: "lease-1", controlBotId: "bot-1" }),
  );
  const url = await wallScreen(ctx, actor, "bot-1");
  expect(url).toMatch(/^https:\/\/app\.example\.test\/novnc\/session\/view\//);
  expect(connectScreen).toHaveBeenCalledExactlyOnceWith(
    { id: "ref-1", botId: "home-1", kind: "docker", providerRef: "ref-1" },
    { view: "stream", interactive: false },
    expect.objectContaining({ botId: "bot-1", userId: "user-1" }),
  );
  for (const fn of [sandbox.keepAlive, sandbox.start, sandbox.resume, enqueue]) {
    expect(fn).not.toHaveBeenCalled();
  }
});

it("answers no screen, without asking the provider, for another member's bot or a kind that would wake", async () => {
  for (const bot of [
    { id: "bot-1", userId: "user-2", computer: computer() },
    own("bot-1", { kind: "boat" }),
    own("bot-1", { state: "suspended" }),
    { id: "bot-1", computer: null },
  ]) {
    const { ctx, connectScreen } = screenCtx(bot);
    expect(await wallScreen(ctx, actor, "bot-1")).toBeNull();
    expect(connectScreen).not.toHaveBeenCalled();
  }
});

it("answers no screen for a single-use sign-in, no address, or a computer the provider finds gone", async () => {
  for (const session of [
    { url: "http://sandbox.internal/screen", singleUseSignIn: { screen: "s" } },
    { url: null },
    new Error("sandbox gone"),
  ]) {
    const { ctx } = screenCtx(own("bot-1"), session);
    expect(await wallScreen(ctx, actor, "bot-1")).toBeNull();
  }
});

it("answers both procedures for the signed-in caller", async () => {
  const { prisma } = fakePrisma([own("bot-1")]);
  const { ctx: screenOnly } = screenCtx(own("bot-1"));
  const ctx = {
    ...screenOnly,
    deps: { ...(screenOnly as unknown as { deps: object }).deps, prisma },
    authed: {
      dozoComputerWall: {
        list: { handler: (fn: unknown) => fn },
        screen: { handler: (fn: unknown) => fn },
      },
    },
  } as unknown as RouterContext;
  const routes = dozoComputerWallRoutes(ctx).dozoComputerWall as unknown as Record<
    "list" | "screen",
    (call: { context: { actor: Actor }; input?: unknown }) => Promise<unknown>
  >;
  await expect(routes.list({ context: { actor } })).resolves.toEqual([
    { botId: "bot-1", state: "running", screen: true },
  ]);
  await expect(
    routes.screen({ context: { actor }, input: { botId: "bot-1" } }),
  ).resolves.toEqual({ url: expect.stringContaining("/novnc/session/view/") });
});
