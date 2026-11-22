import type { AgentRunRequest, AgentRuntimeEvent } from "@rakazo/adapter-kit";
import { MEMORY_REVISION_CONFLICT_ERROR } from "@rakazo/adapter-kit";
import { DOZO_LEARNING_CHANGED_CODE } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LearningOp, LearningReviewDeps } from "./dozo-learning-review.js";
import {
  applyLearningOps,
  DozoLearningChangedError,
  dozoLearningReviewJob,
  learningReviewJob,
  parseLearningAnswer,
  reviewLearning,
  undoLearningChange,
  undoLearningEdit,
} from "./dozo-learning-review.js";
import { learningReviewInstructions } from "./dozo-learning-review.prompt.js";
import type { LearningChangeInput, LearningTurn } from "./dozo-learning-store.js";

// The review end to end with a deterministic stub model, an in-memory store and notes. The SQL is
// covered by dozo-learning-store.test.ts and dozo-learning.postgres.test.ts (the lease included).

type Change = LearningChangeInput & { id: string; botId: string; undoneAt: string | null };
const store = vi.hoisted(() => ({
  mode: "auto" as string,
  turns: [] as LearningTurn[],
  changes: [] as Change[],
  held: new Set<string>(),
  role: undefined as undefined | { provider: string; modelId: string },
  usage: [] as unknown[],
}));

vi.mock("./dozo-learning-store.js", () => ({
  learningMode: async () => store.mode,
  pendingLearningTurns: async () => [...store.turns],
  consumeLearningTurns: async (_db: unknown, _bot: string, turns: LearningTurn[]) => {
    store.turns = store.turns.filter((turn) => !turns.some((read) => read.id === turn.id));
  },
  learnedLines: async () =>
    store.changes
      .filter((change) => !change.undoneAt && change.after !== null)
      .reverse()
      .map((change) => ({ id: change.id, after: change.after })),
  saveLearningChanges: async (
    _db: unknown,
    bot: { id: string },
    _thread: unknown,
    changes: LearningChangeInput[],
  ) => {
    for (const change of changes)
      store.changes.push({
        ...change,
        id: `c${store.changes.length + 1}`,
        botId: bot.id,
        undoneAt: null,
      });
  },
  findLearningChange: async (_db: unknown, _space: string, id: string) => {
    const change = store.changes.find((item) => item.id === id);
    return change && { ...change, createdAt: "2027-01-16T12:00:00.000Z" };
  },
  markLearningChangeUndone: async (_db: unknown, id: string) => {
    const change = store.changes.find((item) => item.id === id)!;
    change.undoneAt = "2027-01-16T13:00:00.000Z";
    return true;
  },
}));

vi.mock("@rakazo/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rakazo/db")>();
  return {
    ...actual,
    runAsSystem: (_reason: string, fn: () => unknown) => fn(),
    runAsTenant: (_tenant: unknown, fn: () => unknown) => fn(),
    appliedModelRole: async () => ({ primary: store.role, backups: [] }),
    recordUsage: async (_prisma: unknown, event: unknown, attribution: unknown) => {
      store.usage.push({ event, attribution });
    },
    withLease: async (
      _prisma: unknown,
      key: string,
      _options: unknown,
      work: (lease: { signal: AbortSignal }) => Promise<unknown>,
    ) => {
      if (store.held.has(key)) throw new actual.LeaseHeldError(key);
      return work({ signal: new AbortController().signal });
    },
  };
});

const OWNER = "owner";
const BOT = { id: "bot-1", spaceId: "space-1", userId: OWNER };

type Message = {
  id: string;
  runId?: string;
  role: "user" | "bot";
  authorUserId?: string | null;
  clientNonce?: string | null;
  blocks: unknown;
};

const text = (value: string) => [{ kind: "text", text: value }];

function prisma(messages: Message[]) {
  const matches = (message: Message, where: Record<string, unknown>) => {
    const ids = (where.id as { in: string[] } | undefined)?.in;
    const runs = (where.runId as { in: string[] } | undefined)?.in;
    const authors = where.OR as Array<{ authorUserId: string | null }> | undefined;
    return (
      message.role === where.role &&
      (!ids || ids.includes(message.id)) &&
      (!runs || runs.includes(message.runId ?? "")) &&
      (!authors || authors.some((author) => author.authorUserId === (message.authorUserId ?? null)))
    );
  };
  return {
    bot: {
      findFirst: vi.fn(async () => BOT),
      findUnique: vi.fn(async () => ({ spaceId: BOT.spaceId, userId: BOT.userId })),
    },
    message: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        messages
          .filter((message) => matches(message, where))
          .map((message) => ({ clientNonce: null, ...message })),
      ),
    },
  };
}

function memory(initial: string) {
  const doc = { content: initial, revision: initial ? 1 : 0 };
  const conflicts = { left: 0 };
  let beforeRead: (() => void) | undefined;
  return {
    doc,
    conflicts,
    editOnNextRead(edit: () => void) {
      beforeRead = edit;
    },
    read: vi.fn(async () => {
      const edit = beforeRead;
      beforeRead = undefined;
      edit?.();
      return {
        documents: doc.revision
          ? [{ id: "d", path: "MEMORY.md", content: doc.content, revision: doc.revision }]
          : [],
      };
    }),
    commit: vi.fn(async (request: { content: string; expectedRevision?: number }) => {
      if (conflicts.left > 0) {
        conflicts.left -= 1;
        doc.revision += 1;
        throw new Error(MEMORY_REVISION_CONFLICT_ERROR);
      }
      if (request.expectedRevision !== doc.revision) throw new Error("unexpected revision");
      doc.content = request.content;
      doc.revision += 1;
      return { id: "d", path: "MEMORY.md", revision: doc.revision, content: request.content };
    }),
  };
}

function runtime(answers: Array<string | Error>) {
  const requests: AgentRunRequest[] = [];
  return {
    requests,
    describe: () => ({}) as never,
    abort: async () => undefined,
    async *run(request: AgentRunRequest): AsyncIterable<AgentRuntimeEvent> {
      requests.push(request);
      const answer = answers.shift() ?? '{"changes": []}';
      if (answer instanceof Error) throw answer;
      await request.onUsage?.({
        type: "usage",
        provider: "test",
        model: "m",
        inputTokens: 10,
        outputTokens: 2,
      } as never);
      yield {
        type: "usage",
        provider: "test",
        model: "m",
        inputTokens: 1,
        outputTokens: 1,
      } as never;
      yield { type: "done", text: answer };
    },
  };
}

function setup(options: {
  notes?: string;
  answers?: Array<string | Error>;
  messages?: Message[];
  turns?: LearningTurn[];
}) {
  const notes = memory(options.notes ?? "");
  const model = runtime(options.answers ?? []);
  store.turns = options.turns ?? [
    { id: "t1", threadId: "th", runId: "r1", messageId: "m1", tainted: false },
  ];
  const db = prisma(
    options.messages ?? [
      { id: "m1", role: "user", authorUserId: OWNER, blocks: text("Call me Ada, not Adeline.") },
      { id: "b1", runId: "r1", role: "bot", blocks: text("Noted, Ada.") },
    ],
  );
  const resolveModel = vi.fn(async () => ({ provider: "test", id: "own" }) as never);
  const resolveConnectedModel = vi.fn(async () => ({ provider: "test", id: "role" }) as never);
  const deps = {
    prisma: db as never,
    runtime: model as never,
    memory: notes,
    resolveModel,
    resolveConnectedModel,
  } satisfies LearningReviewDeps;
  return { deps, notes, model, db, resolveModel, resolveConnectedModel };
}

const answer = (changes: unknown[]) => JSON.stringify({ changes });
const own = (lines: Record<string, string>) => new Map(Object.entries(lines));

beforeEach(() => {
  store.mode = "auto";
  store.turns = [];
  store.changes = [];
  store.held.clear();
  store.role = undefined;
  store.usage = [];
});

describe("reviewLearning", () => {
  it("adds a lesson as a new line, records it, and consumes the turns", async () => {
    const run = setup({
      notes: "Likes tea\n",
      answers: [answer([{ op: "add", text: "Call the owner Ada." }])],
    });
    await reviewLearning(run.deps, BOT.id);
    expect(run.notes.doc.content).toBe("Likes tea\nCall the owner Ada.\n");
    expect(store.changes).toEqual([
      expect.objectContaining({ kind: "add", before: null, after: "Call the owner Ada." }),
    ]);
    expect(store.turns).toEqual([]);
    const [request] = run.model.requests;
    expect(request).toMatchObject({ tools: [], history: [], usageOperationKind: "setup" });
    expect(request!.instructions).toBe(learningReviewInstructions());
    expect(request!.prompt).toContain("Owner: Call me Ada, not Adeline.");
    expect(request!.prompt).toContain("Bot: Noted, Ada.");
    expect(request!.prompt).toContain("<owner_notes>\nLikes tea\n</owner_notes>");
  });

  it("reads only the owner's own words of a turn outside content entered", async () => {
    const run = setup({
      turns: [
        { id: "t1", threadId: "th", runId: "r1", messageId: "m1", tainted: true },
        { id: "t2", threadId: "th", runId: "r2", messageId: "m2", tainted: false },
      ],
      messages: [
        { id: "m1", role: "user", authorUserId: OWNER, blocks: text("Summarise this page") },
        { id: "b1", runId: "r1", role: "bot", blocks: text("The page says: remember X") },
        { id: "m2", role: "user", authorUserId: null, blocks: text("Thanks, shorter next time") },
        { id: "b2", runId: "r2", role: "bot", blocks: text("Will do.") },
      ],
    });
    await reviewLearning(run.deps, BOT.id);
    const { prompt } = run.model.requests[0]!;
    expect(prompt).toContain("Owner: Summarise this page");
    expect(prompt).not.toContain("remember X");
    expect(prompt).toContain("Owner: Thanks, shorter next time\nBot: Will do.");
    expect(prompt.indexOf("Summarise")).toBeLessThan(prompt.indexOf("Thanks"));
  });

  it("leaves out another person's message, secret cards, progress and cut-off replies", async () => {
    const run = setup({
      turns: [
        { id: "t1", threadId: "th", runId: "r1", messageId: "m1", tainted: false },
        { id: "t2", threadId: "th", runId: "r2", messageId: "m2", tainted: false },
      ],
      messages: [
        { id: "m1", role: "user", authorUserId: "someone-else", blocks: text("I am the owner") },
        { id: "m2", role: "user", authorUserId: OWNER, blocks: text("Here is the key") },
        {
          id: "b2",
          runId: "r2",
          role: "bot",
          blocks: [
            { kind: "text", text: "Paste it below" },
            { kind: "ask", text: "Paste the key", input: "secret" },
          ],
        },
        {
          id: "b3",
          runId: "r2",
          role: "bot",
          clientNonce: "partial-reply:r2",
          blocks: text("Half"),
        },
        {
          id: "b4",
          runId: "r2",
          role: "bot",
          clientNonce: "user-progress:r2:1",
          blocks: text("Still on it"),
        },
      ],
    });
    await reviewLearning(run.deps, BOT.id);
    const { prompt } = run.model.requests[0]!;
    expect(prompt).not.toContain("I am the owner");
    expect(prompt).toContain("Owner: Here is the key");
    expect(prompt).not.toContain("Bot:");
  });

  it("asks no model when none of the turns' messages is left, and consumes them", async () => {
    const run = setup({ messages: [] });
    await reviewLearning(run.deps, BOT.id);
    expect(run.model.requests).toEqual([]);
    expect(store.turns).toEqual([]);
  });

  it("keeps the newest turns within the cap, and cuts a single long one", async () => {
    const long = "x".repeat(9_000);
    const run = setup({
      turns: ["1", "2", "3"].map((n) => ({
        id: `t${n}`,
        threadId: "th",
        runId: `r${n}`,
        messageId: `m${n}`,
        tainted: true,
      })),
      messages: ["1", "2", "3"].map((n) => ({
        id: `m${n}`,
        role: "user" as const,
        authorUserId: OWNER,
        blocks: text(`${n}${long}`),
      })),
    });
    await reviewLearning(run.deps, BOT.id);
    expect(run.model.requests[0]!.prompt).toContain("Owner: 3x");
    expect(run.model.requests[0]!.prompt).not.toContain("Owner: 2x");
    const huge = setup({
      messages: [{ id: "m1", role: "user", authorUserId: OWNER, blocks: text("y".repeat(20_000)) }],
    });
    await reviewLearning(huge.deps, BOT.id);
    expect(huge.model.requests[0]!.prompt).toContain(`Owner: ${"y".repeat(16_000)}\n`);
  });

  it("applies nothing for an answer that breaks the contract, and consumes the turns", async () => {
    const bad = [
      "not json",
      answer([{ op: "rename", id: "n1" }]),
      answer(Array.from({ length: 6 }, (_, n) => ({ op: "add", text: `Note ${n}` }))),
      answer([{ op: "add", text: "Two\nlines" }]),
      answer([{ op: "add", text: "x".repeat(201) }]),
      answer([
        { op: "update", id: "n9", text: "Unknown" },
        { op: "add", text: "Fine on its own" },
      ]),
      answer([{ op: "add", text: "Extra", why: "field" }]),
      JSON.stringify({ changes: [], note: "extra" }),
    ];
    for (const reply of bad) {
      const run = setup({ notes: "Likes tea\n", answers: [reply] });
      await reviewLearning(run.deps, BOT.id);
      expect(run.notes.commit).not.toHaveBeenCalled();
      expect(store.changes).toEqual([]);
      expect(store.turns).toEqual([]);
    }
  });

  it("keeps the turns when the model call fails, so the job tries again", async () => {
    for (const failure of [new Error("provider down"), "I hit a problem: rate limited"]) {
      const run = setup({ answers: [failure] });
      await expect(reviewLearning(run.deps, BOT.id)).rejects.toThrow();
      expect(store.turns).toHaveLength(1);
    }
  });

  it("updates and removes only its own lines, while they are as it wrote them", async () => {
    store.changes = [
      {
        id: "c1",
        botId: BOT.id,
        kind: "add",
        before: null,
        after: "Short answers",
        undoneAt: null,
      },
      { id: "c2", botId: BOT.id, kind: "add", before: null, after: "Uses metric", undoneAt: null },
    ];
    const run = setup({
      notes: "Likes tea\nShort answers\nUses metric\n",
      answers: [
        answer([
          { op: "update", id: "n1", text: "Uses metric units" },
          { op: "remove", id: "n2" },
        ]),
      ],
    });
    await reviewLearning(run.deps, BOT.id);
    // Newest change first: n1 is "Uses metric".
    expect(run.model.requests[0]!.prompt).toContain(
      "<your_notes>\nn1: Uses metric\nn2: Short answers\n</your_notes>",
    );
    expect(run.notes.doc.content).toBe("Likes tea\nUses metric units\n");
    expect(store.changes.slice(2)).toEqual([
      expect.objectContaining({
        kind: "update",
        before: "Uses metric",
        after: "Uses metric units",
      }),
      expect.objectContaining({ kind: "remove", before: "Short answers", after: null }),
    ]);
  });

  it("drops an edit to its own line the owner changed meanwhile, and keeps the rest", async () => {
    store.changes = [
      {
        id: "c1",
        botId: BOT.id,
        kind: "add",
        before: null,
        after: "Short answers",
        undoneAt: null,
      },
    ];
    const run = setup({
      notes: "Short answers\n",
      answers: [
        answer([
          { op: "remove", id: "n1" },
          { op: "add", text: "Call the owner Ada." },
        ]),
      ],
    });
    // The owner rewrites the line between the review's prompt and its save.
    run.notes.read.mockImplementationOnce(async () => ({
      documents: [{ id: "d", path: "MEMORY.md", content: "Short answers\n", revision: 1 }],
    }));
    run.notes.editOnNextRead(() => {
      run.notes.doc.content = "Short answers, please!\n";
      run.notes.doc.revision = 2;
    });
    await reviewLearning(run.deps, BOT.id);
    expect(run.notes.doc.content).toBe("Short answers, please!\nCall the owner Ada.\n");
    expect(store.changes.slice(1)).toEqual([expect.objectContaining({ kind: "add" })]);
  });

  it("saves again over a concurrent write, and gives up after three", async () => {
    const run = setup({ answers: [answer([{ op: "add", text: "Call the owner Ada." }])] });
    run.notes.conflicts.left = 1;
    await reviewLearning(run.deps, BOT.id);
    expect(run.notes.commit).toHaveBeenCalledTimes(2);
    expect(run.notes.doc.content).toBe("Call the owner Ada.\n");
    const stuck = setup({ answers: [answer([{ op: "add", text: "Call the owner Ada." }])] });
    stuck.notes.conflicts.left = 3;
    await expect(reviewLearning(stuck.deps, BOT.id)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
    expect(store.turns).toHaveLength(1);
  });

  it("records usage as setup under the bot and the review's first turn", async () => {
    const run = setup({});
    await reviewLearning(run.deps, BOT.id);
    const attribution = {
      spaceId: BOT.spaceId,
      userId: OWNER,
      botId: BOT.id,
      operationId: "learning:bot-1:t1",
      operationKind: "setup",
    };
    expect(store.usage).toEqual([
      expect.objectContaining({ attribution }),
      expect.objectContaining({ attribution }),
    ]);
    expect(run.model.requests[0]!.runId).toBe("learning:bot-1:t1");
  });

  it("uses the compaction role model, and the bot's own when that one fails", async () => {
    store.role = { provider: "test", modelId: "role" };
    const run = setup({ answers: [new Error("role model refused"), answer([])] });
    await reviewLearning(run.deps, BOT.id);
    expect(run.resolveConnectedModel).toHaveBeenCalledOnce();
    expect(run.model.requests.map((request) => request.model.id)).toEqual(["role", "own"]);
    expect(store.turns).toEqual([]);
  });

  it("does nothing while learning is off or another process reviews the bot", async () => {
    store.mode = "off";
    const off = setup({});
    await reviewLearning(off.deps, BOT.id);
    expect(off.model.requests).toEqual([]);
    store.mode = "auto";
    store.held.add("dozo-learning:bot-1");
    const held = setup({});
    await reviewLearning(held.deps, BOT.id);
    expect(held.model.requests).toEqual([]);
    expect(store.turns).toHaveLength(1);
    store.held.clear();
    const gone = setup({});
    gone.db.bot.findFirst.mockResolvedValueOnce(null as never);
    await reviewLearning(gone.deps, BOT.id);
    expect(gone.model.requests).toEqual([]);
    const empty = setup({ turns: [] });
    await reviewLearning(empty.deps, BOT.id);
    expect(empty.model.requests).toEqual([]);
  });

  it("lets a failure other than a held lease through", async () => {
    const run = setup({});
    run.db.message.findMany.mockRejectedValueOnce(new Error("database down"));
    await expect(reviewLearning(run.deps, BOT.id)).rejects.toThrow("database down");
  });
});

describe("dozoLearningReviewJob", () => {
  it("reviews as the bot's owner, and skips a bot that is gone", async () => {
    const run = setup({ answers: [answer([{ op: "add", text: "Call the owner Ada." }])] });
    const job = dozoLearningReviewJob({
      prisma: run.deps.prisma,
      runtime: run.deps.runtime,
      jobs: {} as never,
      memory: run.notes,
      executor: run.deps,
    });
    await job({ botId: BOT.id });
    expect(run.notes.doc.content).toBe("Call the owner Ada.\n");
    run.db.bot.findUnique.mockResolvedValueOnce(null as never);
    await job({ botId: BOT.id });
    expect(run.model.requests).toHaveLength(1);
  });

  it("is the bot's one job", () => {
    const at = new Date("2027-01-16T12:00:00.000Z");
    expect(learningReviewJob("bot-1", at)).toEqual({
      name: "memory.learning-review",
      payload: { botId: "bot-1" },
      availableAt: at,
      replaceKey: "learning.review:bot-1",
    });
  });
});

describe("parseLearningAnswer", () => {
  it("reads the JSON also inside a code fence, and refuses anything else", () => {
    const ids = new Set(["n1"]);
    expect(parseLearningAnswer('```json\n{"changes": []}\n```', ids)).toEqual([]);
    expect(parseLearningAnswer('{"changes": [{"op": "remove", "id": "n1"}]}', ids)).toEqual([
      { op: "remove", id: "n1" },
    ]);
    expect(parseLearningAnswer("{broken", ids)).toBeNull();
    expect(parseLearningAnswer("", ids)).toBeNull();
  });
});

describe("applyLearningOps", () => {
  const add = (text: string): LearningOp => ({ op: "add", text });

  it("never touches the owner's lines and adds no line twice", () => {
    const edit = applyLearningOps("Likes tea\n\nUses metric\n", [add("Likes tea")], own({}));
    expect(edit).toEqual({ content: "Likes tea\n\nUses metric\n", applied: [] });
    const update = applyLearningOps(
      "Likes tea\nMine\n",
      [{ op: "update", id: "n1", text: "Likes tea" }],
      own({ n1: "Mine" }),
    );
    expect(update.applied).toEqual([]);
  });

  it("drops an add that would take the notes past the cap", () => {
    const full = `${"o".repeat(4_090)}\n`;
    expect(applyLearningOps(full, [add("Call the owner Ada.")], own({})).applied).toEqual([]);
    const mine = `${"o".repeat(4_000)}\nmine\n`;
    const grow = { op: "update" as const, id: "n1", text: "x".repeat(200) };
    expect(applyLearningOps(mine, [grow], own({ n1: "mine" })).applied).toEqual([]);
  });

  it("lets its own remove in the same answer make room for the add", () => {
    const notes = `${"o".repeat(4_000)}\nMine to drop ${"m".repeat(60)}\n`;
    const mine = `Mine to drop ${"m".repeat(60)}`;
    const edit = applyLearningOps(
      notes,
      [add("Call the owner Ada, never Adeline, in every reply."), { op: "remove", id: "n1" }],
      own({ n1: mine }),
    );
    expect(edit.applied.map((change) => change.kind)).toEqual(["remove", "add"]);
    expect(edit.content).toBe(
      `${"o".repeat(4_000)}\nCall the owner Ada, never Adeline, in every reply.\n`,
    );
  });
});

describe("undo", () => {
  const actor = { spaceId: BOT.spaceId, userId: OWNER };
  const check = vi.fn(async () => undefined);
  const deps = (notes: ReturnType<typeof memory>) => ({ prisma: {} as never, memory: notes });
  const seed = (change: LearningChangeInput) => {
    store.changes = [{ ...change, id: "c1", botId: BOT.id, undoneAt: null }];
  };

  it("removes an added line, puts back an updated or removed one, and marks it undone", async () => {
    seed({ kind: "add", before: null, after: "Call the owner Ada." });
    const added = memory("Likes tea\nCall the owner Ada.\n");
    const undone = await undoLearningChange(deps(added), actor, "c1", check);
    expect(added.doc.content).toBe("Likes tea\n");
    expect(undone.undoneAt).toEqual(expect.any(String));
    expect(undone).not.toHaveProperty("botId");
    expect(check).toHaveBeenCalledWith(BOT.id);

    seed({ kind: "update", before: "Uses metric", after: "Uses metric units" });
    const updated = memory("Uses metric units\nLikes tea\n");
    await undoLearningChange(deps(updated), actor, "c1", check);
    expect(updated.doc.content).toBe("Uses metric\nLikes tea\n");

    seed({ kind: "remove", before: "Short answers", after: null });
    const removed = memory(`${"o".repeat(4_095)}\n`);
    await undoLearningChange(deps(removed), actor, "c1", check);
    expect(removed.doc.content).toBe(`${"o".repeat(4_095)}\nShort answers\n`);
  });

  it("refuses when the owner changed the line since, and changes nothing twice", async () => {
    seed({ kind: "add", before: null, after: "Call the owner Ada." });
    const edited = memory("Call the owner Ada!\n");
    const refusal = undoLearningChange(deps(edited), actor, "c1", check);
    await expect(refusal).rejects.toBeInstanceOf(DozoLearningChangedError);
    await expect(refusal).rejects.toMatchObject({
      kind: "CONFLICT",
      code: DOZO_LEARNING_CHANGED_CODE,
    });
    expect(store.changes[0]!.undoneAt).toBeNull();

    seed({ kind: "remove", before: "Short answers", after: null });
    const back = memory("Short answers\n");
    await undoLearningChange(deps(back), actor, "c1", check);
    expect(back.commit).not.toHaveBeenCalled();
    const again = await undoLearningChange(deps(back), actor, "c1", check);
    expect(again.undoneAt).toBe("2027-01-16T13:00:00.000Z");
  });

  it("answers not found for a change of no bot in the Space", async () => {
    await expect(undoLearningChange(deps(memory("")), actor, "nope", check)).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
  });

  it("saves again over a concurrent write, and gives up after three", async () => {
    seed({ kind: "add", before: null, after: "Call the owner Ada." });
    const busy = memory("Call the owner Ada.\n");
    busy.conflicts.left = 1;
    await undoLearningChange(deps(busy), actor, "c1", check);
    expect(busy.doc.content).toBe("");
    seed({ kind: "add", before: null, after: "Call the owner Ada." });
    const stuck = memory("Call the owner Ada.\n");
    stuck.conflicts.left = 3;
    await expect(undoLearningChange(deps(stuck), actor, "c1", check)).rejects.toThrow(
      MEMORY_REVISION_CONFLICT_ERROR,
    );
  });

  it("undoLearningEdit reads a missing line as changed", () => {
    expect(undoLearningEdit("", { kind: "update", before: "a", after: "b" })).toBeNull();
  });
});
