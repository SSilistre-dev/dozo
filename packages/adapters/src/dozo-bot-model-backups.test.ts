import { beforeEach, describe, expect, it, vi } from "vitest";
import { runBackupModels } from "./dozo-bot-model-backups.js";
import { effectiveModelRole } from "./model-roles.js";
import { runModelBackups } from "./run-model-start.js";

const fake = vi.hoisted(() => ({ read: vi.fn() }));
const logger = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@rakazo/logging", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/logging")>()),
  getLogger: () => logger,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  readBotModelBackups: fake.read,
}));

// The member's own lists: the account's, and the Space's override when it has one.
const memberRows = [
  {
    role: "main",
    position: 0,
    provider: "p",
    modelId: "main",
    thinkingLevel: null,
    credentialId: null,
  },
  {
    role: "main",
    position: 1,
    provider: "p",
    modelId: "member-backup",
    thinkingLevel: null,
    credentialId: null,
  },
];
const spaceRows = [
  {
    role: "main",
    position: 0,
    provider: "p",
    modelId: "main",
    thinkingLevel: null,
    credentialId: null,
  },
  {
    role: "main",
    position: 1,
    provider: "p",
    modelId: "space-backup",
    thinkingLevel: null,
    credentialId: null,
  },
];

function prisma(options: { spaceOverride?: boolean; runnersConnections?: string[] } = {}) {
  return {
    userModelRoleChoice: { findMany: vi.fn(async () => memberRows) },
    spaceModelRoleChoice: { findMany: vi.fn(async () => spaceRows) },
    spaceSettingOverride: {
      findUnique: vi.fn(async () =>
        options.spaceOverride ? { spaceId: "s", key: "models" } : null,
      ),
      findFirst: vi.fn(async () =>
        options.spaceOverride ? { spaceId: "s", key: "models" } : null,
      ),
    },
    userModelCredential: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        (options.runnersConnections ?? [])
          .filter((id) => where.id.in.includes(id))
          .map((id) => ({ id })),
      ),
    },
    $queryRaw: vi.fn(),
    $executeRaw: vi.fn(),
  };
}

const run = { userId: "runner", spaceId: "s", botId: "bot-1" };
const defaults = {};

describe("runBackupModels", () => {
  beforeEach(() => {
    fake.read.mockReset().mockResolvedValue([]);
  });

  it("takes the runner's backups exactly as before when the bot has none", async () => {
    for (const spaceOverride of [false, true]) {
      const db = prisma({ spaceOverride });
      const before = await effectiveModelRole(db as never, run, "main", defaults);
      expect(await runBackupModels(db as never, run, defaults)).toEqual(before);
    }
    expect(fake.read).toHaveBeenCalledWith(expect.anything(), "bot-1");
  });

  it("reads no bot list for a run without a bot", async () => {
    const db = prisma();
    const { botId: _none, ...botless } = run;
    expect((await runBackupModels(db as never, botless, defaults)).backups).toEqual([
      { provider: "p", modelId: "member-backup" },
    ]);
    expect(fake.read).not.toHaveBeenCalled();
  });

  it("takes the bot's own list, in its order, ahead of the member's and the Space's", async () => {
    fake.read.mockResolvedValue([
      { provider: "q", modelId: "bot-second" },
      { provider: "p", modelId: "bot-first", thinkingLevel: "high" },
    ]);
    const db = prisma({ spaceOverride: true });
    expect(await runBackupModels(db as never, run, defaults)).toEqual({
      backups: [
        { provider: "q", modelId: "bot-second" },
        { provider: "p", modelId: "bot-first", thinkingLevel: "high" },
      ],
    });
    expect(db.userModelRoleChoice.findMany).not.toHaveBeenCalled();
    expect(db.spaceModelRoleChoice.findMany).not.toHaveBeenCalled();
    // No row names a connection, so none is looked up.
    expect(db.userModelCredential.findMany).not.toHaveBeenCalled();
  });

  it("runs a row pinned to another member's connection on the runner's own connection", async () => {
    fake.read.mockResolvedValue([
      { provider: "p", modelId: "a", credentialId: "runners" },
      { provider: "p", modelId: "b", credentialId: "someone-elses" },
      // The same model on two of the saver's connections is one row for this runner.
      { provider: "p", modelId: "c", credentialId: "someone-elses" },
      { provider: "p", modelId: "c", credentialId: "someone-elses-too" },
    ]);
    const db = prisma({ runnersConnections: ["runners"] });
    expect((await runBackupModels(db as never, run, defaults)).backups).toEqual([
      { provider: "p", modelId: "a", credentialId: "runners" },
      { provider: "p", modelId: "b" },
      { provider: "p", modelId: "c" },
    ]);
    expect(db.userModelCredential.findMany).toHaveBeenCalledWith({
      where: {
        userId: "runner",
        id: { in: ["runners", "someone-elses", "someone-elses", "someone-elses-too"] },
      },
      select: { id: true },
    });
  });

  it("says a missing table once, not on every run, and keeps the runner's backups", async () => {
    logger.warn.mockClear();
    fake.read.mockRejectedValue(
      new Error(
        'Raw query failed. Code: `42P01`. Message: `relation "dozo_bot_model_backups" does not exist`',
      ),
    );
    for (let i = 0; i < 3; i++)
      expect((await runBackupModels(prisma() as never, run, defaults)).backups).toEqual([
        { provider: "p", modelId: "member-backup" },
      ]);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("keeps the runner's backups when the bot's list cannot be read", async () => {
    logger.warn.mockClear();
    fake.read.mockRejectedValue(new Error("database down"));
    expect((await runBackupModels(prisma() as never, run, defaults)).backups).toEqual([
      { provider: "p", modelId: "member-backup" },
    ]);
    expect(logger.warn).toHaveBeenCalledWith("bot backup models read failed", expect.anything());
  });
});

describe("a run's backups (run-model-start.ts through its rule)", () => {
  beforeEach(() => {
    fake.read.mockReset();
  });

  const start = (db: ReturnType<typeof prisma>, scripted = false) =>
    runModelBackups(
      { prisma: db } as never,
      { id: "run-1", modelPinned: false, ...run },
      defaults,
      scripted,
      () => undefined,
    );

  it("loads the bot's own backups for a run of that bot", async () => {
    fake.read.mockResolvedValue([{ provider: "q", modelId: "bot-backup" }]);
    expect(await start(prisma()).load()).toEqual([{ provider: "q", modelId: "bot-backup" }]);
  });

  it("loads the runner's backups for a bot without its own, and none for a scripted run", async () => {
    fake.read.mockResolvedValue([]);
    expect(await start(prisma()).load()).toEqual([{ provider: "p", modelId: "member-backup" }]);
    expect(await start(prisma(), true).load()).toEqual([]);
  });
});
