import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoBotCallsRoutes } from "./dozo-bot-calls.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const getBot = vi.fn();
const publishRosterChange = vi.fn(async () => undefined);
const stored = { allowed: false, voice: true };
const prisma = {
  userVoiceCredential: { findFirst: vi.fn(async () => (stored.voice ? { id: "voice-1" } : null)) },
  $queryRaw: vi.fn(async () => (stored.allowed ? [{ botId: "bot-1" }] : [])),
  $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
    stored.allowed = strings.join("?").includes("INSERT");
    return 1;
  }),
  space: { findUnique: async () => null },
};

/** The router's real deps shape: whether calls are on lives under `env`, as the server sets it. */
function client(userId: string, env: Record<string, unknown> = { phoneCallsEnabled: true }) {
  const ctx = createRouterContext({
    prisma,
    secrets: { load: vi.fn() },
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env,
  } as unknown as RouterDeps);
  return createRouterClient(dozoBotCallsRoutes({ ...ctx, repos: { ...ctx.repos, getBot } }), {
    context: {
      actor: { userId, spaceId: "space-1", email: "a@example.test", isDeploymentOwner: false },
    },
  }).dozoBotCalls;
}

describe("a bot's permission to call", () => {
  beforeEach(() => {
    stored.allowed = false;
    stored.voice = true;
    prisma.$executeRaw.mockClear();
    publishRosterChange.mockClear();
    getBot.mockReset().mockResolvedValue({ id: "bot-1", userId: "ada" });
  });

  it("is shown to the bot's own person when the server has calls on and a voice is connected", async () => {
    expect(await client("ada").get({ botId: "bot-1" })).toEqual({ allowed: false, available: true });
  });

  it("is hidden when the server has calls off or no voice is connected", async () => {
    expect((await client("ada", {}).get({ botId: "bot-1" })).available).toBe(false);
    stored.voice = false;
    expect((await client("ada").get({ botId: "bot-1" })).available).toBe(false);
  });

  it("saves, reads back, and tells the person's other devices", async () => {
    expect(await client("ada").set({ botId: "bot-1", allowed: true })).toEqual({
      allowed: true,
      available: true,
    });
    expect((await client("ada").get({ botId: "bot-1" })).allowed).toBe(true);
    expect(publishRosterChange).toHaveBeenCalledWith({ userIds: ["ada"] });
  });

  it("saves where calls are not available yet, which only keeps the setting hidden", async () => {
    expect(await client("ada", {}).set({ botId: "bot-1", allowed: true })).toEqual({
      allowed: true,
      available: false,
    });
    expect(prisma.$executeRaw).toHaveBeenCalledOnce();
  });

  it("shows another member nothing and forbids their change", async () => {
    expect(await client("bea").get({ botId: "bot-1" })).toEqual({ allowed: false, available: false });
    await expect(client("bea").set({ botId: "bot-1", allowed: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });
});
