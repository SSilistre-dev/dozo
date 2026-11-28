import type { Actor, DozoBotDefinition } from "@rakazo/contracts";
import { BOT_INSTRUCTIONS_MAX_LENGTH, DOZO_BOT_SHARE_LIMITS } from "@rakazo/contracts";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentImportServices } from "./bots/agent-import.js";
import { botShareKind } from "./dozo-bot-share-kind.js";
import {
  botShareDefinition,
  botShareFingerprint,
  botShareStatus,
  cloneBotShare,
  dozoBotShareRoutes,
  openBotShare,
  publishBotShare,
  revokeBotShare,
} from "./dozo-bot-shares.js";
import { DOZO_SHARE_KINDS } from "./dozo-share-kinds.js";
import type { RouterContext } from "./routes/context.js";

const writeImportedBot = vi.hoisted(() => vi.fn());
vi.mock("./bots/agent-import.js", async (load) => ({
  ...(await load<typeof import("./bots/agent-import.js")>()),
  writeImportedBot,
  savedTimeZone: async () => "Europe/Istanbul",
}));

const actor = { userId: "owner", spaceId: "space-1", email: "o@example.test" } as Actor;
const TOKEN = "B".repeat(43);
const PICTURE = "data:image/png;base64,AAAA";

const definition: DozoBotDefinition = {
  name: "Gardener",
  avatar: { color: "#22aa55", avatarSet: "organic" },
  instructions: "Water the plants.\nCheck the soil.\nSecond line\nThird\nFifth line stays private",
  description: "Knows plants",
  routines: [{ name: "Morning", prompt: "Look at the garden", crons: ["0 8 * * *"] }],
};

const linkRow = (kind: string, targetId: string, id = `link-${targetId}`) => ({
  id,
  kind,
  targetId,
  createdAt: new Date("2026-11-01T00:00:00Z"),
  expiresAt: new Date("2026-12-01T00:00:00Z"),
  revokedAt: null,
});

type Sql = { text: string; values: unknown[] };

/** A database with one bot; each `$queryRaw` answers with the next of `answers`. */
function fakeDb(options: {
  bot?: Record<string, unknown> | null;
  routines?: { name: string; prompt: string; crons: string[] }[];
  answers?: unknown[][];
}) {
  const statements: Sql[] = [];
  const answers = [...(options.answers ?? [])];
  const bot =
    options.bot === null
      ? null
      : {
          name: "Gardener",
          description: "Knows plants",
          instructions: definition.instructions,
          color: "#22aa55",
          avatarSet: "organic",
          id: "bot-1",
          ...options.bot,
        };
  const prisma = {
    bot: { findFirst: vi.fn(async () => bot) },
    routine: { findMany: vi.fn(async () => options.routines ?? definition.routines) },
    user: { findUnique: vi.fn(async () => ({ email: "o@example.test" })) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      statements.push({ text: strings.join("?").replace(/\s+/g, " ").trim(), values });
      return answers.shift() ?? [];
    }),
    $transaction: vi.fn(async (run: (tx: unknown) => Promise<unknown>) => run(prisma)),
  };
  return { prisma: prisma as never, raw: prisma, statements };
}

beforeEach(() => writeImportedBot.mockReset());

describe("what publishing makes public", () => {
  it("holds the bot's text and its owner's scheduled routines only", async () => {
    const { prisma, raw } = fakeDb({
      routines: [...definition.routines, { name: "On mail", prompt: "Answer", crons: [] }],
    });
    const shown = await botShareDefinition(prisma, actor, "bot-1", false);
    expect(shown).toEqual({ definition, hasPicture: false });
    expect(raw.routine.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: "bot-1", spaceId: "space-1", userId: "owner" },
      }),
    );
  });

  it("leaves an uploaded picture out unless the owner includes it", async () => {
    const { prisma } = fakeDb({ bot: { color: PICTURE } });
    const left = await botShareDefinition(prisma, actor, "bot-1", false);
    expect(left.hasPicture).toBe(true);
    expect(left.definition.avatar.color).toBeNull();
    const kept = await botShareDefinition(prisma, actor, "bot-1", true);
    expect(kept.definition.avatar.color).toBe(PICTURE);
  });

  it("shows no avatar value it does not recognise, and the default set for an unknown one", async () => {
    const { prisma } = fakeDb({ bot: { color: "javascript:x", avatarSet: "gone" } });
    const { definition: shown } = await botShareDefinition(prisma, actor, "bot-1", true);
    expect(shown.avatar).toEqual({ color: null, avatarSet: "organic" });
  });

  it("is refused as not found for a bot the caller does not own", async () => {
    const { prisma } = fakeDb({ bot: null });
    await expect(botShareDefinition(prisma, actor, "bot-1", false)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it.each([
    ["instructions", { bot: { instructions: "x".repeat(BOT_INSTRUCTIONS_MAX_LENGTH + 1) } }],
    [
      "routines",
      {
        routines: Array.from({ length: DOZO_BOT_SHARE_LIMITS.routines + 1 }, (_, index) => ({
          name: `R${index}`,
          prompt: "p",
          crons: ["0 8 * * *"],
        })),
      },
    ],
  ])("refuses %s over the limit, naming them", async (field, options) => {
    await expect(
      botShareDefinition(fakeDb(options).prisma, actor, "bot-1", false),
    ).rejects.toMatchObject({
      kind: "BAD_REQUEST",
      code: "BOT_SHARE_TOO_LARGE",
      message: expect.stringContaining(field),
    });
  });
});

describe("fingerprint", () => {
  it("is the same whatever order a stored copy keeps the keys in", () => {
    const reordered = JSON.parse(
      JSON.stringify({
        routines: definition.routines,
        description: definition.description,
        instructions: definition.instructions,
        avatar: { avatarSet: "organic", color: "#22aa55" },
        name: definition.name,
      }),
    ) as DozoBotDefinition;
    expect(botShareFingerprint(reordered)).toBe(botShareFingerprint(definition));
    expect(botShareFingerprint({ ...definition, name: "Other" })).not.toBe(
      botShareFingerprint(definition),
    );
  });
});

describe("publishing", () => {
  const fingerprint = botShareFingerprint(definition);
  const input = { botId: "bot-1", includePicture: false, fingerprint };

  it("is refused, storing nothing, when the bot changed since the preview", async () => {
    const { prisma, statements } = fakeDb({});
    await expect(
      publishBotShare(prisma, actor, { ...input, fingerprint: "0".repeat(64) }),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: "BOT_SHARE_CHANGED" });
    expect(statements).toEqual([]);
  });

  it("stores the snapshot, revokes the bot's earlier links only, then makes a link", async () => {
    const { prisma, statements } = fakeDb({
      answers: [
        [{ botId: "bot-1" }],
        [linkRow("bot", "bot-1"), linkRow("bot", "bot-2"), linkRow("replay", "bot-1")],
        [{ id: "link-bot-1" }],
        [linkRow("bot", "bot-1", "link-new")],
      ],
    });
    const made = await publishBotShare(prisma, actor, input);
    expect(made.link.id).toBe("link-new");
    expect(statements[0]!.text).toContain("INSERT INTO dozo_bot_shares");
    expect(JSON.parse(String(statements[0]!.values[3]))).toEqual(definition);
    const revokes = statements.filter((sql) => sql.text.startsWith("UPDATE dozo_share_links"));
    expect(revokes.map((sql) => sql.values[0])).toEqual(["link-bot-1"]);
    expect(statements.at(-1)!.text).toContain("INSERT INTO dozo_share_links");
    expect(statements.at(-1)!.values).toEqual(expect.arrayContaining(["bot", "bot-1"]));
  });
});

describe("status and revoking", () => {
  it("names the bot's newest live link while a snapshot stands behind it", async () => {
    const { prisma } = fakeDb({ answers: [[linkRow("bot", "bot-1")], [{ botId: "bot-1" }]] });
    expect(await botShareStatus(prisma, actor, "bot-1")).toEqual({
      link: { id: "link-bot-1", expiresAt: "2026-12-01T00:00:00.000Z" },
    });
  });

  it("names no link when nothing was published behind it", async () => {
    const { prisma } = fakeDb({ answers: [[linkRow("bot", "bot-1")], []] });
    expect(await botShareStatus(prisma, actor, "bot-1")).toEqual({ link: null });
  });

  it("refuses another member's bot as not found", async () => {
    const { prisma } = fakeDb({ bot: null });
    await expect(botShareStatus(prisma, actor, "bot-1")).rejects.toBeInstanceOf(IsolationError);
    await expect(revokeBotShare(prisma, actor, "bot-1")).rejects.toBeInstanceOf(IsolationError);
  });

  it("revokes the bot's links and deletes the snapshot", async () => {
    const { prisma, statements } = fakeDb({
      answers: [[linkRow("bot", "bot-1")], [{ id: "link-bot-1" }], [{ botId: "bot-1" }]],
    });
    await revokeBotShare(prisma, actor, "bot-1");
    expect(statements[1]!.text).toContain("UPDATE dozo_share_links");
    expect(statements[2]!.text).toContain("DELETE FROM dozo_bot_shares");
    expect(statements[2]!.values).toEqual(["bot-1", "owner", "space-1"]);
  });
});

describe("the bot kind", () => {
  const link = { userId: "owner", spaceId: "space-1", targetId: "bot-1" };

  it("is registered under its kind", () => {
    expect(DOZO_SHARE_KINDS.bot).toBe(botShareKind);
  });

  it("shows only the avatar, name, first lines of the instructions and routine names", async () => {
    const { prisma } = fakeDb({ answers: [[{ definition }]] });
    expect(await botShareKind.load(prisma, link)).toEqual({
      name: "Gardener",
      avatar: definition.avatar,
      instructionsExcerpt: "Water the plants.\nCheck the soil.\nSecond line\nThird",
      routineNames: ["Morning"],
    });
  });

  it("shows nothing without a snapshot, or with one that no longer passes the limits", async () => {
    expect(await botShareKind.load(fakeDb({}).prisma, link)).toBeNull();
    const broken = fakeDb({ answers: [[{ definition: { ...definition, secret: "x" } }]] });
    expect(await botShareKind.load(broken.prisma, link)).toBeNull();
  });

  it("lets only the owner of a bot that is not archived share it", async () => {
    const { prisma, raw } = fakeDb({});
    expect(await botShareKind.canShare(prisma, actor, "bot-1")).toBe(true);
    expect(raw.bot.findFirst).toHaveBeenCalledWith({
      where: { id: "bot-1", spaceId: "space-1", userId: "owner", archivedAt: null },
      select: { id: true },
    });
    expect(await botShareKind.canShare(fakeDb({ bot: null }).prisma, actor, "bot-1")).toBe(false);
  });
});

describe("opening and copying", () => {
  const liveLink = [{ userId: "owner", spaceId: "space-1", kind: "bot", targetId: "bot-1" }];
  const reader = { userId: "reader", spaceId: "space-9", email: "r@example.test" } as Actor;
  const services = (answers: unknown[][]) =>
    ({ prisma: fakeDb({ answers }).prisma }) as unknown as AgentImportServices;

  it("gives a signed-in reader the whole definition behind a live link", async () => {
    const { prisma } = fakeDb({ answers: [liveLink, [{ definition }]] });
    expect(await openBotShare(prisma, TOKEN)).toEqual({
      definition,
      fingerprint: botShareFingerprint(definition),
    });
  });

  it("refuses a token that opens no bot link as not found", async () => {
    const other = [{ ...liveLink[0], kind: "replay" }];
    await expect(openBotShare(fakeDb({ answers: [other] }).prisma, TOKEN)).rejects.toBeInstanceOf(
      IsolationError,
    );
  });

  it("refuses a copy of a definition other than the one shown", async () => {
    const copy = cloneBotShare(services([liveLink, [{ definition }]]), reader, {
      token: TOKEN,
      fingerprint: "0".repeat(64),
      requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    });
    await expect(copy).rejects.toMatchObject({ code: "BOT_SHARE_CHANGED" });
    expect(writeImportedBot).not.toHaveBeenCalled();
  });

  it("makes the reader's own bot as a template does, routines paused, keyed by the request", async () => {
    writeImportedBot.mockResolvedValue({ bot: { id: "copy-1" }, created: true });
    const requestId = "3b241101-e2bb-4255-8caf-4136c566a962";
    const made = await cloneBotShare(services([liveLink, [{ definition }]]), reader, {
      token: TOKEN,
      fingerprint: botShareFingerprint(definition),
      requestId,
    });
    expect(made).toEqual({ bot: { id: "copy-1" } });
    const [, who, request] = writeImportedBot.mock.calls[0]!;
    expect(who).toBe(reader);
    expect(request).toMatchObject({
      importKey: `dozo-bot-share:${requestId}`,
      name: "Gardener",
      description: "Knows plants",
      color: "#22aa55",
      avatarSet: "organic",
      selection: { instructions: ["instructions"], skills: [], routines: ["routine-0"] },
    });
    expect(JSON.stringify(request)).not.toContain("bot-1");
    const built = await request.build();
    expect(built.plan.instructions[0].content).toBe(definition.instructions);
    expect(built.plan.skills).toEqual([]);
    expect(built.routineInputs.get("routine-0")).toMatchObject({
      name: "Morning",
      active: false,
      timezone: "Europe/Istanbul",
    });
  });

  it("keeps the owner's colour out when the definition has none", async () => {
    writeImportedBot.mockResolvedValue({ bot: { id: "copy-2" }, created: true });
    const plain = { ...definition, avatar: { color: null, avatarSet: "organic" as const } };
    await cloneBotShare(services([liveLink, [{ definition: plain }]]), reader, {
      token: TOKEN,
      fingerprint: botShareFingerprint(plain),
      requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
    });
    expect(writeImportedBot.mock.calls[0]![2].color).toBeUndefined();
  });
});

describe("procedures", () => {
  type Handler = (call: {
    context: { actor: Actor; signal?: AbortSignal };
    input?: unknown;
  }) => Promise<unknown>;
  function routes(prisma: never) {
    const authed = new Proxy(
      {},
      { get: () => new Proxy({}, { get: () => ({ handler: (fn: Handler) => fn }) }) },
    );
    const ctx = {
      deps: { prisma, env: { webOrigin: "https://app.example.test" } },
      authed,
      agentImportServices: { prisma },
    };
    return dozoBotShareRoutes(ctx as unknown as RouterContext).dozoBotShares as unknown as Record<
      "preview" | "publish" | "status" | "revoke" | "open" | "clone",
      Handler
    >;
  }

  it("previews with the fingerprint publishing checks", async () => {
    const shown = await routes(fakeDb({}).prisma).preview({
      context: { actor },
      input: { botId: "bot-1", includePicture: false },
    });
    expect(shown).toEqual({
      definition,
      hasPicture: false,
      fingerprint: botShareFingerprint(definition),
    });
  });

  it("answers a publish with the link's web address and expiry", async () => {
    const { prisma } = fakeDb({
      answers: [[{ botId: "bot-1" }], [], [linkRow("bot", "bot-1")]],
    });
    const made = (await routes(prisma).publish({
      context: { actor },
      input: {
        botId: "bot-1",
        includePicture: false,
        fingerprint: botShareFingerprint(definition),
      },
    })) as { url: string; expiresAt: string };
    expect(made.url).toMatch(/^https:\/\/app\.example\.test\/s\/[A-Za-z0-9_-]{43}$/);
    expect(made.expiresAt).toBe("2026-12-01T00:00:00.000Z");
  });

  it("answers status, revoke, open and clone", async () => {
    expect(
      await routes(fakeDb({ answers: [[], []] }).prisma).status({
        context: { actor },
        input: { botId: "bot-1" },
      }),
    ).toEqual({ link: null });
    expect(
      await routes(fakeDb({}).prisma).revoke({ context: { actor }, input: { botId: "bot-1" } }),
    ).toEqual({ revoked: true });
    const liveLink = [{ userId: "owner", spaceId: "space-1", kind: "bot", targetId: "bot-1" }];
    const opened = (await routes(fakeDb({ answers: [liveLink, [{ definition }]] }).prisma).open({
      context: { actor },
      input: { token: TOKEN },
    })) as { definition: DozoBotDefinition };
    expect(opened.definition).toEqual(definition);
    writeImportedBot.mockResolvedValue({ bot: { id: "copy-3" }, created: true });
    expect(
      await routes(fakeDb({ answers: [liveLink, [{ definition }]] }).prisma).clone({
        context: { actor },
        input: {
          token: TOKEN,
          fingerprint: botShareFingerprint(definition),
          requestId: "3b241101-e2bb-4255-8caf-4136c566a962",
        },
      }),
    ).toEqual({ bot: { id: "copy-3" } });
  });
});
