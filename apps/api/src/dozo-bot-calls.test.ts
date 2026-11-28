import { createRouterClient } from "@orpc/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoBotCallsRoutes } from "./dozo-bot-calls.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), available: vi.fn() }));
vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/adapters")>()),
  readBotCallPermission: fake.read,
  writeBotCallPermission: fake.write,
  botCallsAvailable: fake.available,
}));

const getBot = vi.fn();

function client(userId: string) {
  const ctx = createRouterContext({
    prisma: {},
    secrets: { load: vi.fn() },
    events: { notify: () => undefined, publishSpaceChange: () => undefined },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(dozoBotCallsRoutes({ ...ctx, repos: { ...ctx.repos, getBot } }), {
    context: {
      actor: { userId, spaceId: "space-1", email: "a@example.test", isDeploymentOwner: false },
    },
  }).dozoBotCalls;
}

describe("a bot's permission to call", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue(true);
    fake.write.mockReset().mockResolvedValue(undefined);
    fake.available.mockReset().mockResolvedValue(true);
    getBot.mockReset().mockResolvedValue({ id: "bot-1", userId: "ada" });
  });

  it("reads and saves for the bot's own person", async () => {
    expect(await client("ada").get({ botId: "bot-1" })).toEqual({ allowed: true, available: true });
    expect(await client("ada").set({ botId: "bot-1", allowed: false })).toEqual({
      allowed: false,
      available: true,
    });
    expect(fake.write).toHaveBeenCalledWith(expect.anything(), {
      userId: "ada",
      botId: "bot-1",
      spaceId: "space-1",
      allowed: false,
    });
  });

  it("shows another member nothing and refuses their change", async () => {
    expect(await client("bea").get({ botId: "bot-1" })).toEqual({
      allowed: false,
      available: false,
    });
    await expect(client("bea").set({ botId: "bot-1", allowed: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("refuses a change where calls are not available", async () => {
    fake.available.mockResolvedValue(false);
    await expect(client("ada").set({ botId: "bot-1", allowed: true })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(fake.write).not.toHaveBeenCalled();
  });
});
