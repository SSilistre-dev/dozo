import { createRouterClient } from "@orpc/server";
import type { AgentRunRequest, AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { SkillPlaybook, TeachRecordingEvent } from "@rakazo/core";
import {
  buildPlaybookFromRecording,
  ClientError,
  scrubTeachEvents,
  typedValuesFromRecording,
} from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { SKILL_NOT_DRAFT, TEACH_RECORDING_UNREADABLE } from "./dozo-taught-skills.js";
import type { DozoTeachInput } from "./dozo-teach.js";
import { createDozoTeach, dozoTeachRoutes, dozoTeachWiring } from "./dozo-teach.js";
import type { TeachClickLabeller } from "./dozo-teach-labels.js";
import type { TeachValueSuggester } from "./dozo-teach-suggest.js";
import { createTeachValueSuggester } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const at = "2026-01-01T00:00:00.000Z";
const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at, kind: "key", key }));
const tab: TeachRecordingEvent = { at, kind: "key", key: "Tab" };
const events: TeachRecordingEvent[] = [
  ...typing("ali@example.test"),
  tab,
  ...typing("hunter2"),
  tab,
  ...typing("my secret phrase"),
  tab,
  { at, kind: "key", sensitive: true },
];
const TYPED = ["ali@example.test", "hunter2", "my secret phrase"];
const playbook: SkillPlaybook = buildPlaybookFromRecording("Sign in", events);
const teacher: Actor = {
  userId: "ada",
  spaceId: "space-1",
  email: "ada@example.test",
  isDeploymentOwner: false,
};
const member: Actor = {
  userId: "bob",
  spaceId: "space-1",
  email: "bob@example.test",
  isDeploymentOwner: false,
};

type Row = {
  id: string;
  spaceId: string;
  userId: string;
  botId: string;
  name: string;
  goal: string;
  status: string;
  playbook: unknown;
  recording: unknown;
};

type Stored = {
  skillId: string;
  spaceId: string;
  userId: string;
  values: string;
  targets?: string | null;
  suggestions: unknown;
  due?: boolean;
};

/**
 * A database holding one skill and its values store, answering the store's SQL as Postgres would
 * (with content encryption off, so values are plain JSON text).
 */
function fakeDb(row: Row, stored: Stored | null) {
  const state = { stored };
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const executeRaw = vi.fn(async (strings: TemplateStringsArray) => {
    if (sql(strings).includes('DELETE FROM "dozo_teach_values"') && state.stored?.due) {
      state.stored = null;
    }
    return 1;
  });
  const queryRaw = vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
    const text = sql(strings);
    // Nothing the previous release left: this draft's recording was forgotten when drafted.
    if (text.includes("FROM taught_skills")) return [];
    if (text.includes('UPDATE "dozo_teach_values"')) {
      if (!state.stored) return [];
      state.stored.suggestions ??= JSON.parse(params[0] as string);
      return [{ suggestions: state.stored.suggestions }];
    }
    return state.stored && !state.stored.due ? [state.stored] : [];
  });
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        where.id === row.id && where.spaceId === row.spaceId ? row : null,
      ),
    },
    $executeRaw: executeRaw,
    $queryRaw: queryRaw,
  };
  return { prisma, state, queryRaw };
}

function setup(
  options: {
    row?: Partial<Row>;
    stored?: Partial<Stored> | null;
    suggest?: TeachValueSuggester | null;
    label?: TeachClickLabeller;
    events?: TeachRecordingEvent[];
  } = {},
) {
  const recorded = options.events ?? events;
  const row: Row = {
    id: "skill-1",
    spaceId: "space-1",
    userId: "ada",
    botId: "bot-1",
    name: "",
    goal: "Sign in",
    status: "draft",
    playbook: buildPlaybookFromRecording("Sign in", recorded),
    // As the draft keeps it: nothing typed is left in the recording.
    recording: {
      events: scrubTeachEvents(recorded),
      snapshots: [
        { at, summary: "Sign in" },
        { at, summary: "hunter2 - Search" },
      ],
    },
    ...options.row,
  };
  const stored: Stored | null =
    options.stored === null
      ? null
      : {
          skillId: row.id,
          spaceId: row.spaceId,
          userId: "ada",
          values: JSON.stringify(typedValuesFromRecording(recorded)),
          suggestions: null,
          ...options.stored,
        };
  const db = fakeDb(row, stored);
  const saved = () => ({
    id: row.id,
    botId: row.botId,
    name: "Sign in",
    goal: row.goal,
    status: "saved" as const,
    playbook,
    recording: { events: [], snapshots: [] },
    startedAt: null,
    expiresAt: null,
    stoppedAt: null,
    createdAt: at,
    updatedAt: at,
  });
  const taughtSkills = {
    updateDraft: vi.fn(async () => ({}) as never),
    save: vi.fn(async () => saved()),
    testRun: vi.fn(async () => ({ runId: "run-1" })),
    decideSavedValues: vi.fn(async () => saved()),
  };
  const suggest =
    options.suggest === null
      ? undefined
      : (options.suggest ??
        vi.fn<TeachValueSuggester>(async () => ({
          "{{value 1}}": { name: "email" },
          "{{value 2}}": { name: "password" },
        })));
  const teach = createDozoTeach({
    prisma: db.prisma as never,
    taughtSkills,
    suggest,
    label: options.label,
  });
  return { teach, db, taughtSkills, suggest, row };
}

const input = (decisions: DozoTeachInput["decisions"] = {}): DozoTeachInput => ({
  skillId: "skill-1",
  name: "Sign in",
  playbook,
  decisions,
});

describe("review", () => {
  it("gives the teacher the typed values with suggestions, and caches them", async () => {
    const { teach, suggest, db } = setup();
    const { values } = await teach.review(teacher, "skill-1");
    expect(values).toEqual([
      {
        placeholder: "{{value 1}}",
        text: "ali@example.test",
        secret: false,
        suggestion: { name: "email" },
      },
      {
        placeholder: "{{value 2}}",
        text: "hunter2",
        secret: false,
        suggestion: { name: "password" },
      },
      { placeholder: "{{value 3}}", text: "my secret phrase", secret: false },
      { placeholder: "{{value 4}}", text: null, secret: true },
    ]);
    // The model is told the steps and shapes: never a value, nor a window title.
    expect(suggest).toHaveBeenCalledWith(
      teacher,
      { botId: "bot-1", goal: "Sign in", steps: playbook.steps },
      [
        { placeholder: "{{value 1}}", shape: "9-20 characters, has @" },
        { placeholder: "{{value 2}}", shape: "4-8 characters, letters and digits" },
        { placeholder: "{{value 3}}", shape: "9-20 characters, has spaces" },
        { placeholder: "{{value 4}}", shape: "protected input" },
      ],
    );
    expect(db.state.stored?.suggestions).toEqual({
      "{{value 1}}": { name: "email" },
      "{{value 2}}": { name: "password" },
    });
  });

  it("never sends a typed value to the model", async () => {
    const run = vi.fn(async function* (_request: AgentRunRequest) {
      yield { type: "done", text: "[]" } as never;
    });
    const suggest = createTeachValueSuggester({
      prisma: {} as never,
      runtime: { describe: () => ({ capabilities: {} }), run } as unknown as AgentRuntime,
      resolveModel: async () => ({ provider: "any", model: "m" }) as never,
    });
    await setup({ suggest }).teach.review(teacher, "skill-1");
    expect(run).toHaveBeenCalledOnce();
    const body = JSON.stringify(run.mock.calls[0]);
    for (const typed of TYPED) expect(body).not.toContain(typed);
    expect(body).not.toContain("Search");
    expect(body).toContain("{{value 3}}");
  });

  it("first forgets what is typed in the skill, if the previous release drafted it", async () => {
    const { teach, db } = setup();
    await teach.review(teacher, "skill-1");
    const [strings, ...params] = db.queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    expect(strings.join("?")).toContain("FROM taught_skills");
    expect(params).toContain("skill-1");
    expect(params).toContain("space-1");
  });

  it("reads cached suggestions instead of asking again", async () => {
    const { teach, suggest } = setup({
      stored: { suggestions: { "{{value 1}}": { name: "login" } } },
    });
    const { values } = await teach.review(teacher, "skill-1");
    expect(values[0]).toMatchObject({ suggestion: { name: "login" } });
    expect(values[1]?.suggestion).toBeUndefined();
    expect(suggest).not.toHaveBeenCalled();
  });

  it("caches a failed call too, so the model is not asked again", async () => {
    const failed = setup({ suggest: vi.fn(async () => null) });
    const { values } = await failed.teach.review(teacher, "skill-1");
    expect(values.every((value) => !value.suggestion)).toBe(true);
    expect(failed.db.state.stored?.suggestions).toEqual({});

    const none = setup({ suggest: null });
    expect((await none.teach.review(teacher, "skill-1")).values).toHaveLength(4);
    expect(none.db.state.stored?.suggestions).toBeNull();
  });

  it("keeps what another review wrote first, and what it got when the values went", async () => {
    const raced = setup();
    vi.mocked(raced.suggest!).mockImplementationOnce(async () => {
      raced.db.state.stored!.suggestions = { "{{value 1}}": { name: "login" } };
      return { "{{value 1}}": { name: "email" } };
    });
    expect((await raced.teach.review(teacher, "skill-1")).values[0]?.suggestion).toEqual({
      name: "login",
    });

    const gone = setup();
    vi.mocked(gone.suggest!).mockImplementationOnce(async () => {
      gone.db.state.stored = null;
      return { "{{value 1}}": { name: "email" } };
    });
    expect((await gone.teach.review(teacher, "skill-1")).values[0]?.suggestion).toEqual({
      name: "email",
    });
  });

  it("gives nobody else the values, and none once saved, due or never stored", async () => {
    expect((await setup().teach.review(member, "skill-1")).values).toEqual([]);
    // A member who took the draft over by editing it is not who typed the values.
    const handedOver = setup({ row: { userId: "bob" } });
    expect((await handedOver.teach.review(member, "skill-1")).values).toEqual([]);
    const saved = setup({ row: { status: "saved" } });
    expect((await saved.teach.review(teacher, "skill-1")).values).toEqual([]);
    const due = setup({ stored: { due: true } });
    expect((await due.teach.review(teacher, "skill-1")).values).toEqual([]);
    expect(due.db.state.stored).toBeNull();
    const none = setup({ stored: null });
    expect((await none.teach.review(teacher, "skill-1")).values).toEqual([]);
    expect(none.suggest).not.toHaveBeenCalled();
    const other = setup({ stored: { userId: "bob" } });
    expect((await other.teach.review(teacher, "skill-1")).values).toEqual([]);
  });

  it("refuses a skill of another Space", async () => {
    const { teach } = setup();
    await expect(
      teach.review({ ...teacher, spaceId: "space-2" }, "skill-1"),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("save", () => {
  it("hands the draft and the decisions to the service's one-transaction save", async () => {
    const { teach, taughtSkills } = setup();
    const decisions = { "{{value 2}}": { action: "hidden" as const, name: "password" } };
    await teach.save(teacher, input(decisions));
    expect(taughtSkills.save).toHaveBeenCalledWith(teacher, "skill-1", "Sign in", {
      playbook,
      decisions,
      removedTargets: undefined,
      labels: {},
    });
    expect(taughtSkills.updateDraft).not.toHaveBeenCalled();
  });
});

describe("test", () => {
  it("keeps the draft's placeholders and runs the prompt with the decisions applied", async () => {
    const { teach, taughtSkills } = setup({ row: { name: "Saved name" } });
    const result = await teach.test(teacher, {
      ...input({
        "{{value 1}}": { action: "fixed" },
        "{{value 2}}": { action: "hidden", name: "password" },
      }),
      name: undefined,
    });
    expect(result).toEqual({ runId: "run-1" });
    expect(taughtSkills.updateDraft).toHaveBeenCalledWith(teacher, "skill-1", {
      name: undefined,
      playbook,
    });
    const [, , prompt] = taughtSkills.testRun.mock.calls[0] as unknown as [unknown, string, string];
    expect(prompt).toContain("Run taught skill: Saved name");
    expect(prompt).toContain("safe test run");
    expect(prompt).toContain('Type the text "ali@example.test".');
    expect(prompt).toContain("Secret inputs ({{password}}, {{value_4}})");
    expect(prompt).not.toContain("hunter2");
    expect(taughtSkills.save).not.toHaveBeenCalled();
  });

  it("refuses to keep a protected value as text", async () => {
    const { teach, taughtSkills } = setup();
    await expect(
      teach.test(teacher, input({ "{{value 4}}": { action: "fixed" } })),
    ).rejects.toBeInstanceOf(ClientError);
    expect(taughtSkills.testRun).not.toHaveBeenCalled();
  });

  it("refuses decisions from someone else or for a saved skill", async () => {
    const decided = input({ "{{value 1}}": { action: "variable", name: "email" } });
    await expect(setup().teach.test(member, decided)).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await expect(
      setup({ row: { status: "saved" } }).teach.test(teacher, decided),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: SKILL_NOT_DRAFT });
  });

  it("runs someone else's test as upstream, and names it after the goal", async () => {
    const { teach, taughtSkills } = setup();
    await teach.test(member, { ...input(), name: "" });
    const [, , prompt] = taughtSkills.testRun.mock.calls[0] as unknown as [unknown, string, string];
    expect(prompt).toContain("Run taught skill: Sign in");
    expect(prompt).toContain("Type {{value 1}}.");
  });
});

describe("a recording not in its shape", () => {
  it("is a refusal the person can act on, not a server error", async () => {
    const { teach } = setup({ row: { recording: { events: [null], snapshots: [] } } });
    await expect(teach.test(teacher, input())).rejects.toMatchObject({
      kind: "CONFLICT",
      code: TEACH_RECORDING_UNREADABLE,
    });
  });
});

describe("what each click hit", () => {
  const click = (x: number, y: number): TeachRecordingEvent => ({
    at,
    kind: "pointer",
    x,
    y,
    type: "click",
  });
  // Drafted, the clicks are events 0, 3, 6 and 8; the one at 6 is before protected input.
  const clicked: TeachRecordingEvent[] = [
    click(10, 20),
    ...typing("ali@example.test"),
    tab,
    click(30, 40),
    ...typing("hunter2"),
    tab,
    click(50, 60),
    { at, kind: "key", sensitive: true },
    click(70, 80),
  ];
  const clickedPlaybook = buildPlaybookFromRecording("Sign in", clicked);
  const withTargets = (options: { label?: TeachClickLabeller } = {}) => {
    const context = setup({
      events: clicked,
      label: options.label,
      stored: {
        // Drafting kept no picture of the click before protected input.
        targets: JSON.stringify([
          { eventIndex: 0, image: "AAAA" },
          { eventIndex: 3, image: "BBBB" },
          { eventIndex: 8, image: "DDDD" },
        ]),
      },
    });
    const recording = context.row.recording as Record<string, unknown>;
    recording.dozoTargets = [
      { eventIndex: 0, window: "Form" },
      { eventIndex: 3, window: "Form" },
      { eventIndex: 6, window: "Form" },
      { eventIndex: 8, window: "Done" },
    ];
    return context;
  };
  const draft = (
    decisions: DozoTeachInput["decisions"] = {},
    removedTargets?: string[],
  ): DozoTeachInput => ({
    skillId: "skill-1",
    name: "Sign in",
    playbook: clickedPlaybook,
    decisions,
    removedTargets,
  });

  it("shows the teacher the pictures, without asking the model about them", async () => {
    const label = vi.fn<TeachClickLabeller>(async () => ({}));
    const { teach } = withTargets({ label });
    const { targets } = await teach.review(teacher, "skill-1");
    expect(targets).toEqual([
      { id: "0", step: 0, window: "Form", image: "data:image/webp;base64,AAAA" },
      { id: "3", step: 3, window: "Form", image: "data:image/webp;base64,BBBB" },
      { id: "6", step: 6, window: "Form" },
      { id: "8", step: 8, window: "Done", image: "data:image/webp;base64,DDDD" },
    ]);
    expect(label).not.toHaveBeenCalled();
    expect((await withTargets().teach.review(member, "skill-1")).targets).toEqual([]);
    // Pictures alone keep a store row; the review still shows them.
    const only = setup({
      events: [click(1, 2)],
      stored: { targets: '[{"eventIndex":0,"image":"A"}]' },
    });
    (only.row.recording as Record<string, unknown>).dozoTargets = [{ eventIndex: 0 }];
    expect(await only.teach.review(teacher, "skill-1")).toEqual({
      values: [],
      targets: [{ id: "0", step: 0, image: "data:image/webp;base64,A" }],
    });
  });

  it("asks for labels at the save, only for kept pictures before no hidden value", async () => {
    const label = vi.fn<TeachClickLabeller>(async () => ({ "0": "Email field" }));
    const { teach, taughtSkills } = withTargets({ label });
    const decisions = { "{{value 2}}": { action: "hidden" as const, name: "password" } };
    await teach.save(teacher, draft(decisions, ["8"]));
    // 3 is before a value the teacher hid, 6 before protected input, 8 removed.
    expect(label).toHaveBeenCalledWith(teacher, expect.objectContaining({ goal: "Sign in" }), [
      { id: "0", image: "AAAA" },
    ]);
    expect(taughtSkills.save).toHaveBeenCalledWith(teacher, "skill-1", "Sign in", {
      playbook: clickedPlaybook,
      decisions,
      removedTargets: ["8"],
      labels: { "0": "Email field" },
    });
  });

  it("saves without labels when none can be made or nothing is left to label", async () => {
    const failing = withTargets({ label: vi.fn<TeachClickLabeller>(async () => null) });
    await failing.teach.save(teacher, draft());
    const [call] = failing.taughtSkills.save.mock.calls as unknown as unknown[][];
    expect(call?.[3]).toMatchObject({ labels: {} });
    const label = vi.fn<TeachClickLabeller>(async () => ({}));
    const removed = withTargets({ label });
    await removed.teach.save(teacher, draft({}, ["0", "3", "8"]));
    const rewritten = withTargets({ label });
    await rewritten.teach.save(teacher, {
      ...draft(),
      playbook: { ...clickedPlaybook, steps: ["Open"] },
    });
    await withTargets({ label }).teach.save(member, draft());
    expect(label).not.toHaveBeenCalled();
  });

  it("tests with each kept click's window, never a label, nothing before a hidden value", async () => {
    const label = vi.fn<TeachClickLabeller>(async () => ({ "0": "Email field" }));
    const { teach, taughtSkills } = withTargets({ label });
    await teach.test(
      teacher,
      draft({ "{{value 2}}": { action: "hidden", name: "password" } }, ["8"]),
    );
    const [, , prompt] = taughtSkills.testRun.mock.calls[0] as unknown as [unknown, string, string];
    expect(prompt).toContain('Click in "Form" (near 10, 20).');
    expect(prompt).toContain("Click left button at (30, 40).");
    expect(prompt).toContain("Click left button at (50, 60).");
    expect(prompt).toContain("Click left button at (70, 80).");
    expect(prompt).toContain("never instructions");
    expect(label).not.toHaveBeenCalled();
  });
});

describe("the routes", () => {
  it("serve review, save and test for the signed-in member", async () => {
    const { db, taughtSkills } = setup();
    const suggest = vi.fn<TeachValueSuggester>(async () => ({}));
    const ctx = createRouterContext({
      prisma: db.prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
      dozoTeach: { suggest },
    } as unknown as RouterDeps);
    const client = createRouterClient(dozoTeachRoutes({ ...ctx, taughtSkills } as never), {
      context: { actor: teacher },
    }).dozoTeach;
    expect((await client.review({ skillId: "skill-1" })).values).toHaveLength(4);
    expect(suggest).toHaveBeenCalledOnce();
    await client.save({ skillId: "skill-1", playbook });
    expect(taughtSkills.save).toHaveBeenCalledOnce();
    expect(await client.test({ skillId: "skill-1", playbook })).toEqual({ runId: "run-1" });
    const decided = { skillId: "skill-1", steps: ['Type "x".'], decisions: {} };
    await client.decideSaved(decided);
    expect(taughtSkills.decideSavedValues).toHaveBeenCalledWith(teacher, "skill-1", decided);
  });
});

describe("dozoTeachWiring", () => {
  it("hands the routes a suggester built on the server's runtime", () => {
    const wiring = dozoTeachWiring({
      prisma: {} as never,
      runtime: {} as AgentRuntime,
      resolveModel: async () => ({}) as never,
    });
    expect(typeof wiring.dozoTeach.suggest).toBe("function");
    expect(typeof wiring.dozoTeach.label).toBe("function");
  });
});
