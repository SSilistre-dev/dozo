import { createRouterClient } from "@orpc/server";
import { ClientError } from "@rakazo/core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoBotModelBackupsRoutes } from "./dozo-bot-model-backups.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const fake = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn() }));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readBotModelBackups: fake.read,
  writeBotModelBackups: fake.write,
}));

const publishRosterChange = vi.fn(async () => undefined);
const prisma = { space: { findUnique: async () => null } };
const getBot = vi.fn();
const validateRoleChoices = vi.fn();
const BACKUPS = [
  { provider: "provider-a", modelId: "model-a" },
  { provider: "provider-b", modelId: "model-b", credentialId: "connection-b" },
];

function client(userId: string | null) {
  const ctx = createRouterContext({
    prisma,
    secrets: { load: vi.fn() },
    events: { notify: () => undefined, publishSpaceChange: () => undefined, publishRosterChange },
    env: {},
  } as unknown as RouterDeps);
  return createRouterClient(
    dozoBotModelBackupsRoutes({ ...ctx, repos: { ...ctx.repos, getBot }, validateRoleChoices }),
    {
      context: {
        actor: userId
          ? {
              userId,
              spaceId: "space-1",
              email: `${userId}@example.test`,
              isDeploymentOwner: false,
            }
          : null,
      },
    },
  ).dozoBotModelBackups;
}

describe("bot backup model routes", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue(BACKUPS);
    fake.write.mockReset().mockResolvedValue(true);
    getBot.mockReset().mockResolvedValue({ id: "bot-1", userId: "maker" });
    validateRoleChoices.mockReset().mockResolvedValue(undefined);
    publishRosterChange.mockClear();
  });

  it("reads the list of a bot the caller sees", async () => {
    expect(await client("ada").get({ botId: "bot-1" })).toEqual({ backups: BACKUPS });
    expect(getBot).toHaveBeenCalledWith(expect.objectContaining({ userId: "ada" }), "bot-1");
    expect(fake.read).toHaveBeenCalledWith(prisma, "bot-1");
  });

  it("saves a list checked as the caller's own backups and signals the Space", async () => {
    // A member other than the bot's maker may change its backups, as they may its model.
    expect(await client("ada").set({ botId: "bot-1", backups: BACKUPS })).toEqual({
      backups: BACKUPS,
    });
    expect(validateRoleChoices).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ada", spaceId: "space-1" }),
      "main",
      BACKUPS,
    );
    expect(fake.write).toHaveBeenCalledWith(
      prisma,
      { botId: "bot-1", spaceId: "space-1" },
      BACKUPS,
    );
    expect(publishRosterChange).toHaveBeenCalledWith({ spaceIds: ["space-1"] });
  });

  it("refuses another member's connection, as a member's own backups do, and saves nothing", async () => {
    validateRoleChoices.mockRejectedValue(
      new ClientError("BAD_REQUEST", "Connect that model provider first"),
    );
    await expect(
      client("ada").set({
        botId: "bot-1",
        backups: [{ provider: "provider-a", modelId: "model-a", credentialId: "someone-elses" }],
      }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.write).not.toHaveBeenCalled();
    expect(publishRosterChange).not.toHaveBeenCalled();
  });

  it("refuses a bot the caller cannot see, before reading or checking anything", async () => {
    getBot.mockRejectedValue(new ClientError("NOT_FOUND", "Bot not found"));
    await expect(client("ada").get({ botId: "bot-x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(client("ada").set({ botId: "bot-x", backups: [] })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(fake.read).not.toHaveBeenCalled();
    expect(validateRoleChoices).not.toHaveBeenCalled();
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("clears the list with an empty one", async () => {
    expect(await client("ada").set({ botId: "bot-1", backups: [] })).toEqual({ backups: [] });
    expect(fake.write).toHaveBeenCalledWith(prisma, { botId: "bot-1", spaceId: "space-1" }, []);
  });

  it("refuses more backups than a member may have, or the same one twice", async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({
      provider: "provider-a",
      modelId: `model-${index}`,
    }));
    await expect(client("ada").set({ botId: "bot-1", backups: many })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    await expect(
      client("ada").set({ botId: "bot-1", backups: [BACKUPS[0]!, BACKUPS[0]!] }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("refuses a caller who is not signed in", async () => {
    await expect(client(null).get({ botId: "bot-1" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });
});
