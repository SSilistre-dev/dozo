import { beforeEach, describe, expect, it, vi } from "vitest";
import { knownSkillNames, suggestLearnedSkill } from "./dozo-learning-skill.js";

// The suggestion with an in-memory bot row and skills; teaching's card is stubbed and asserted on.
// The SQL and the real card are covered by dozo-learning.postgres.test.ts.

const state = vi.hoisted(() => ({
  /** The bot's learning row: undefined without one; the id of its unanswered suggestion. */
  row: undefined as undefined | { pendingSkillId: string | null },
  suggestion: null as string | null,
  cards: [] as Array<{ skillId: string; status: string; threadId?: string }>,
  catalog: [] as Array<{ name: string }>,
  rejected: [] as string[],
  failCard: false,
}));

vi.mock("./dozo-learning-store.js", () => ({
  lockSkillSuggestion: async () => state.row,
  rejectedLearningSkills: async () => state.rejected,
  setSkillSuggestion: async (_db: unknown, _bot: string, skillId: string) => {
    state.suggestion = skillId;
  },
}));
vi.mock("./tools/skill-tools.js", () => ({
  listAgentSkillRecords: async () => state.catalog,
}));
vi.mock("./bots/teaching-session.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./bots/teaching-session.js")>()),
  emitSkillDraftMessages: async (
    _deps: unknown,
    _actor: unknown,
    skill: { id: string; status: string },
    bot: { thread: { id: string } | null },
  ) => {
    if (state.failCard) throw new Error("database down");
    state.cards.push({ skillId: skill.id, status: skill.status, threadId: bot.thread?.id });
  },
}));

const BOT = { id: "bot-1", spaceId: "space-1", userId: "owner" };
const SKILL = {
  name: "Weekly report",
  whenToUse: "When the owner asks for the weekly sales report.",
  inputs: ["The week"],
  steps: ["Open the sales sheet for the week.", "Sum each region and write three lines."],
  whatToReturn: "The three lines.",
};

function prisma(taught: Array<Record<string, unknown>> = []) {
  const skills = [...taught];
  const db = {
    taughtSkill: {
      findMany: vi.fn(async () => skills),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) =>
          skills.find((skill) => skill.id === where.id) ?? null,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        const row = { id: `skill-${skills.length + 1}`, ...data };
        skills.push(row);
        return row;
      }),
    },
    bot: {
      findUnique: vi.fn(async () => ({ ...BOT, thread: { id: "chat-1" } })),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(db)),
  };
  return { db, skills };
}
const deps = (db: unknown) => ({ prisma: db as never, events: { notify: vi.fn() } });

beforeEach(() => {
  state.row = { pendingSkillId: null };
  state.suggestion = null;
  state.cards = [];
  state.catalog = [];
  state.rejected = [];
  state.failCard = false;
});

describe("suggestLearnedSkill", () => {
  it("makes a draft, never a saved skill, and posts teaching's card in the bot's chat", async () => {
    const { db, skills } = prisma();
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(true);
    expect(skills).toEqual([
      expect.objectContaining({
        spaceId: BOT.spaceId,
        botId: BOT.id,
        userId: BOT.userId,
        name: "Weekly report",
        goal: SKILL.whenToUse,
        status: "draft",
        recording: { events: [], snapshots: [] },
        playbook: expect.objectContaining({
          whenToUse: SKILL.whenToUse,
          inputs: SKILL.inputs,
          steps: SKILL.steps,
          whatToReturn: SKILL.whatToReturn,
          // Teaching's own boundaries: nothing is sent, paid or deleted without the owner.
          approvalBoundaries: expect.stringContaining("without explicit user approval"),
        }),
      }),
    ]);
    expect(state.suggestion).toBe("skill-1");
    expect(state.cards).toEqual([{ skillId: "skill-1", status: "draft", threadId: "chat-1" }]);
  });

  it("suggests nothing named, in any spacing or case, as a skill of the bot, of the catalog or dismissed, read under the lock", async () => {
    for (const [taught, catalog, rejected] of [
      [[{ id: "s0", name: "  weekly   REPORT ", goal: "g", status: "saved" }], [], []],
      [[{ id: "s0", name: "", goal: "Weekly Report", status: "draft" }], [], []],
      [[], [{ name: "Weekly report" }], []],
      [[], [], ["WEEKLY REPORT"]],
      // Past the fifty names a review is shown, still checked.
      [
        [],
        [
          ...Array.from({ length: 60 }, (_, n) => ({ name: `Skill ${n}` })),
          { name: "weekly report" },
        ],
        [],
      ],
    ] as const) {
      state.catalog = [...catalog];
      state.rejected = [...rejected];
      const { db, skills } = prisma(taught.map((row) => ({ ...row })));
      expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(false);
      expect(skills).toHaveLength(taught.length);
      expect(state.cards).toEqual([]);
    }
  });

  it("keeps the draft when its card cannot be posted, and does not fail the review", async () => {
    state.failCard = true;
    const { db, skills } = prisma();
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(true);
    expect(skills).toHaveLength(1);
    expect(state.suggestion).toBe("skill-1");
  });

  it("while the last suggestion is unanswered, makes none and only posts that one's card again", async () => {
    state.row = { pendingSkillId: "skill-1" };
    const { db, skills } = prisma([{ id: "skill-1", status: "draft", name: "Inbox sweep" }]);
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(false);
    expect(skills).toHaveLength(1);
    expect(state.cards).toEqual([{ skillId: "skill-1", status: "draft", threadId: "chat-1" }]);
    // Deleted meanwhile: nothing to post.
    state.cards = [];
    state.row = { pendingSkillId: "gone" };
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(false);
    expect(state.cards).toEqual([]);
  });

  it("suggests nothing for a bot with no learning row", async () => {
    state.row = undefined;
    const { db, skills } = prisma();
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(false);
    expect(skills).toEqual([]);
    expect(state.cards).toEqual([]);
  });

  it("posts no card for a bot deleted meanwhile", async () => {
    const { db } = prisma();
    db.bot.findUnique.mockResolvedValueOnce(null as never);
    expect(await suggestLearnedSkill(deps(db), BOT, SKILL)).toBe(true);
    expect(state.cards).toEqual([]);
  });
});

describe("knownSkillNames", () => {
  it("lists the bot's taught skills and the catalog by name only, each once", async () => {
    state.catalog = [{ name: "Daily plan" }, { name: "Weekly report" }];
    const { db } = prisma([
      { name: "Weekly report", goal: "x" },
      { name: "", goal: "Sort the inbox every morning" },
    ]);
    expect(await knownSkillNames(db as never, BOT)).toEqual([
      "Weekly report",
      "Sort the inbox every morning",
      "Daily plan",
    ]);
    expect(db.taughtSkill.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { botId: BOT.id, spaceId: BOT.spaceId, status: { in: ["draft", "saved"] } },
        select: { name: true, goal: true },
      }),
    );
  });

  it("shows at most fifty", async () => {
    state.catalog = Array.from({ length: 60 }, (_, n) => ({ name: `Skill ${n}` }));
    const { db } = prisma();
    expect(await knownSkillNames(db as never, BOT)).toHaveLength(50);
  });
});
