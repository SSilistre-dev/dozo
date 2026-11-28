import { describe, expect, it } from "vitest";
import type { Prisma, PrismaClient } from "./database/client.js";
import {
  dozoReplayableChat,
  holdStepFrame,
  STEP_FRAMES_BOT_BYTES,
  settleStepFrames,
  stepFrameRoom,
} from "./dozo-step-frames.js";

// Runs on the branded tree only: the limits exist once the brand rules are applied.

const MB = 1024 * 1024;

/**
 * A database that answers by what is asked: whether the server bills, the organization's files,
 * the bot's frames and its replies with kept frames. Records every statement.
 */
function database(
  init: {
    billingOn?: boolean;
    orgUsed?: number;
    botUsed?: number;
    replies?: { runId: string; bytes: number }[];
  } = {},
) {
  const state = { billingOn: false, orgUsed: 0, botUsed: 0, replies: [], ...init };
  const statements: string[] = [];
  const answer = (text: string) => {
    if (text.includes("set_config") || text.includes("current_setting")) return [{}];
    if (text.includes("pg_advisory_xact_lock")) return [{ lock: "" }];
    if (text.includes('JOIN "spaces"')) return [{ used: String(state.orgUsed) }];
    if (text.includes("DELETE FROM artifacts a"))
      return [{ id: "old-pending", storageKey: "k-old" }];
    if (text.includes('COALESCE(SUM("size")')) return [{ used: String(state.botUsed) }];
    if (text.includes('GROUP BY a."runId"'))
      return state.replies.map((reply) => ({ runId: reply.runId, bytes: String(reply.bytes) }));
    if (text.includes("DELETE FROM artifacts")) return [{ id: "evicted", storageKey: "k-evicted" }];
    return [];
  };
  const sql = (query: TemplateStringsArray | Prisma.Sql) =>
    ("sql" in query ? query.sql : query.join("?")).replace(/\s+/g, " ");
  const tx = {
    deploymentSettings: { findUnique: async () => ({ modelCreditsEnabled: state.billingOn }) },
    space: {
      findUnique: async () => ({
        organizationId: "org-1",
        organization: { billing: null, dozoPlanGrant: null },
      }),
    },
    dozoPlanQuota: { findMany: async () => [] },
    $queryRaw: async (query: TemplateStringsArray | Prisma.Sql) => {
      const text = sql(query);
      statements.push(text);
      return answer(text);
    },
    $executeRaw: async (query: TemplateStringsArray) => {
      statements.push(sql(query));
      return 1;
    },
    $queryRawUnsafe: async () => [{}],
    $executeRawUnsafe: async () => 1,
  };
  const prisma = {
    ...tx,
    $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
  };
  return {
    state,
    statements,
    tx: tx as unknown as Prisma.TransactionClient,
    prisma: prisma as unknown as PrismaClient,
  };
}

const frame = { spaceId: "space-1", botId: "bot-1", bytes: MB };

describe("dozoReplayableChat", () => {
  const thread = {
    botId: "bot-1",
    userId: "ada",
    groupId: null,
    helperBotId: null,
    externalConversationId: null,
  };
  const bot = { id: "bot-1", userId: "ada" };

  it("is the owner's own chat with their own bot, in a run they started", () => {
    expect(dozoReplayableChat(thread, bot, "ada")).toBe(true);
  });

  it.each([
    ["a group", { ...thread, groupId: "g-1" }, bot, "ada"],
    ["a helper chat", { ...thread, helperBotId: "bot-2" }, bot, "ada"],
    ["a chat app's conversation", { ...thread, externalConversationId: "x" }, bot, "ada"],
    ["another bot's chat", { ...thread, botId: "bot-2" }, bot, "ada"],
    ["another member's chat", { ...thread, userId: "bob" }, bot, "ada"],
    ["another member's bot", thread, { id: "bot-1", userId: "bob" }, "ada"],
    ["another member's run", thread, bot, "bob"],
  ])("is never %s", (_name, chat, owner, runUserId) => {
    expect(dozoReplayableChat(chat, owner, runUserId)).toBe(false);
  });
});

describe("holdStepFrame", () => {
  it("allows a frame within the bot's budget, removing pending frames of ended runs", async () => {
    const { tx, statements } = database({ botUsed: 10 * MB });
    expect(await holdStepFrame(tx, frame)).toEqual({
      allowed: true,
      removed: [{ id: "old-pending", storageKey: "k-old" }],
    });
    expect(statements.some((text) => text.includes('JOIN "spaces"'))).toBe(false);
  });

  it("refuses a frame that would take the organization into its last tenth", async () => {
    const { tx, statements } = database({ billingOn: true, orgUsed: 450 * MB - MB / 2 });
    expect(await holdStepFrame(tx, frame)).toEqual({ allowed: false, removed: [] });
    expect(statements.some((text) => text.includes('COALESCE(SUM("size")'))).toBe(false);
    const roomy = database({ billingOn: true, orgUsed: 400 * MB });
    expect((await holdStepFrame(roomy.tx, frame)).allowed).toBe(true);
  });

  it("removes the oldest replies' frames first, a reply at a time, until the frame fits", async () => {
    const { tx, statements } = database({
      botUsed: STEP_FRAMES_BOT_BYTES,
      replies: [
        { runId: "oldest", bytes: MB / 2 },
        { runId: "older", bytes: MB },
        { runId: "newer", bytes: 20 * MB },
      ],
    });
    const held = await holdStepFrame(tx, frame);
    expect(held.allowed).toBe(true);
    expect(held.removed.map((row) => row.id)).toEqual(["old-pending", "evicted"]);
    expect(statements.some((text) => text.includes('"runId" = ANY('))).toBe(true);
  });

  it("refuses when the replies it may remove do not make room", async () => {
    const { tx } = database({
      botUsed: STEP_FRAMES_BOT_BYTES,
      replies: [{ runId: "only", bytes: MB / 2 }],
    });
    expect((await holdStepFrame(tx, frame)).allowed).toBe(false);
  });
});

describe("stepFrameRoom", () => {
  it("is what leaves the last tenth free, or null without a limit", async () => {
    expect(await stepFrameRoom(database().prisma, "space-1")).toBeNull();
    expect(
      await stepFrameRoom(database({ billingOn: true, orgUsed: 400 * MB }).prisma, "space-1"),
    ).toBe(50 * MB);
  });
});

describe("settleStepFrames", () => {
  it("keeps the frames the reply links and removes the run's other pending frames", async () => {
    const { prisma, statements } = database();
    const removed = await settleStepFrames(prisma, {
      spaceId: "space-1",
      botId: "bot-1",
      runId: "run-1",
      linked: ["a-1"],
    });
    expect(removed).toEqual([{ id: "evicted", storageKey: "k-evicted" }]);
    expect(statements.some((text) => text.startsWith(" UPDATE artifacts SET"))).toBe(true);
  });
});
