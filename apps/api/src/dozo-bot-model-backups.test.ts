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
/** The caller's own connections: those whose id starts with the caller's name. */
/** One transaction's client, which locks with a raw query. */
const tx = {
  $queryRaw: vi.fn(async (_strings: TemplateStringsArray, ..._values: unknown[]) => [{}]),
  userModelCredential: {
    findMany: vi.fn(async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
      where.id.in.filter((id) => id.startsWith(where.userId)).map((id) => ({ id })),
    ),
  },
};
const prisma = {
  $transaction: vi.fn(async (work: (client: typeof tx) => unknown) => work(tx)),
  space: { findUnique: async () => null },
  userModelCredential: {
    findMany: vi.fn(async ({ where }: { where: { userId: string; id: { in: string[] } } }) =>
      where.id.in.filter((id) => id.startsWith(where.userId)).map((id) => ({ id })),
    ),
  },
};
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
    // A member other than the bot's maker may change its backups, as they may its model. The
    // bot has none yet, so every row is checked as the caller's own.
    fake.read.mockResolvedValue([]);
    expect(await client("ada").set({ botId: "bot-1", backups: BACKUPS })).toEqual({
      backups: BACKUPS,
    });
    expect(validateRoleChoices).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "ada", spaceId: "space-1" }),
      "main",
      BACKUPS,
    );
    expect(fake.write).toHaveBeenCalledWith(tx, { botId: "bot-1", spaceId: "space-1" }, BACKUPS);
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
    expect(fake.write).toHaveBeenCalledWith(tx, { botId: "bot-1", spaceId: "space-1" }, []);
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

describe("saving in one transaction", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue([]);
    fake.write.mockReset().mockResolvedValue(true);
    getBot.mockReset().mockResolvedValue({ id: "bot-1", userId: "maker" });
    validateRoleChoices.mockReset().mockResolvedValue(undefined);
    tx.$queryRaw.mockClear();
  });

  it("holds the bot's row while it reads the saved list and writes the new one", async () => {
    await client("ada").set({ botId: "bot-1", backups: BACKUPS });
    const [lock, ...values] = tx.$queryRaw.mock.calls[0]!;
    expect(lock.join("?")).toContain("FOR UPDATE");
    expect(values).toEqual(["bot-1"]);
    expect(fake.read).toHaveBeenCalledWith(tx, "bot-1");
    expect(fake.write).toHaveBeenCalledWith(tx, { botId: "bot-1", spaceId: "space-1" }, BACKUPS);
  });
});

describe("a list with another member's pinned rows", () => {
  // Ada pinned two rows to her own connections; Ben edits the bot's list.
  const ADAS = [
    { provider: "provider-a", modelId: "model-a", credentialId: "ada-connection-1" },
    { provider: "provider-b", modelId: "model-b", credentialId: "ada-connection-2" },
  ];
  const BENS = { provider: "provider-c", modelId: "model-c" };

  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue(ADAS);
    fake.write.mockReset().mockResolvedValue(true);
    getBot.mockReset().mockResolvedValue({ id: "bot-1", userId: "ada" });
    // As the real check: a pinned connection must be the saver's own.
    validateRoleChoices.mockReset().mockImplementation(async (actor, _role, choices) => {
      for (const choice of choices as Array<{ credentialId?: string }>)
        if (choice.credentialId && !choice.credentialId.startsWith(actor.userId))
          throw new ClientError("BAD_REQUEST", "Connect that model provider first");
    });
  });

  it("keeps her rows as they are when Ben adds, moves or removes one", async () => {
    for (const backups of [[...ADAS, BENS], [ADAS[1]!, BENS, ADAS[0]!], [ADAS[1]!]]) {
      expect(await client("ben").set({ botId: "bot-1", backups })).toEqual({ backups });
      expect(fake.write).toHaveBeenLastCalledWith(
        tx,
        { botId: "bot-1", spaceId: "space-1" },
        backups,
      );
    }
    // Only Ben's own new row was checked as his.
    expect(validateRoleChoices).toHaveBeenCalledWith(expect.anything(), "main", [BENS]);
  });

  it("refuses her connection on a row Ben adds or changes", async () => {
    for (const backups of [
      [...ADAS, { provider: "provider-c", modelId: "model-c", credentialId: "ada-connection-1" }],
      [{ ...ADAS[0]!, modelId: "model-z" }, ADAS[1]!],
    ]) {
      await expect(client("ben").set({ botId: "bot-1", backups })).rejects.toMatchObject({
        code: "BAD_REQUEST",
      });
    }
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("checks a row on Ada's own connection as hers, even when it is already saved", async () => {
    expect(await client("ada").set({ botId: "bot-1", backups: [ADAS[0]!, BENS] })).toEqual({
      backups: [ADAS[0]!, BENS],
    });
    expect(validateRoleChoices).toHaveBeenCalledWith(expect.anything(), "main", [ADAS[0], BENS]);
  });

  it("takes only this bot's own saved list as the rows to keep", async () => {
    // The rows are saved on another bot, not this one.
    fake.read.mockImplementation(async (_db, botId: string) => (botId === "bot-1" ? [] : ADAS));
    await expect(client("ben").set({ botId: "bot-1", backups: ADAS })).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(fake.read).toHaveBeenCalledWith(tx, "bot-1");
    expect(fake.write).not.toHaveBeenCalled();
  });
});
