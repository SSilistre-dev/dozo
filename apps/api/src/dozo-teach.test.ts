import { createRouterClient } from "@orpc/server";
import type { AgentRuntime } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { SkillPlaybook, TeachRecordingEvent } from "@rakazo/core";
import { buildPlaybookFromRecording, ClientError } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { DozoTeachInput } from "./dozo-teach.js";
import {
  createDozoTeach,
  dozoTeachRoutes,
  dozoTeachWiring,
  SKILL_NOT_DRAFT,
} from "./dozo-teach.js";
import type { TeachValueSuggester } from "./dozo-teach-suggest.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const at = "2026-01-01T00:00:00.000Z";
const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at, kind: "key", key }));
const events: TeachRecordingEvent[] = [
  ...typing("ali@example.test"),
  { at, kind: "key", key: "Tab" },
  ...typing("Gizli-5678"),
  { at, kind: "key", key: "Tab" },
  { at, kind: "key", sensitive: true },
];
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
  recording: unknown;
};

function setup(
  options: {
    row?: Partial<Row>;
    suggest?: TeachValueSuggester | null;
    /** What the row holds when the review locks it to write the suggestions. */
    locked?: unknown[];
  } = {},
) {
  const row: Row = {
    id: "skill-1",
    spaceId: "space-1",
    userId: "ada",
    botId: "bot-1",
    name: "",
    goal: "Sign in",
    status: "draft",
    recording: { events, snapshots: [] },
    ...options.row,
  };
  const executeRaw = vi.fn(async (..._args: unknown[]) => 1);
  const queryRaw = vi.fn(async (..._args: unknown[]) => options.locked ?? [row]);
  const prisma = {
    taughtSkill: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        where.id === row.id && where.spaceId === row.spaceId ? row : null,
      ),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) =>
      work({ $queryRaw: queryRaw, $executeRaw: executeRaw }),
    ),
  };
  const taughtSkills = {
    updateDraft: vi.fn(async () => ({}) as never),
    save: vi.fn(async () => ({
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
    })),
    testRun: vi.fn(async () => ({ runId: "run-1" })),
  };
  const suggest =
    options.suggest === null
      ? undefined
      : (options.suggest ??
        vi.fn<TeachValueSuggester>(async () => ({
          "{{value 1}}": { name: "email", secret: false },
          "{{value 2}}": { name: "password", secret: true },
          "{{value 3}}": { name: "pin", secret: false },
        })));
  const teach = createDozoTeach({ prisma: prisma as never, taughtSkills, suggest });
  return { teach, prisma, taughtSkills, suggest, executeRaw, queryRaw, row };
}

const input = (decisions: DozoTeachInput["decisions"] = {}): DozoTeachInput => ({
  skillId: "skill-1",
  name: "Sign in",
  playbook,
  decisions,
});

describe("review", () => {
  it("gives the teacher the typed values with suggestions, and caches them", async () => {
    const { teach, suggest, executeRaw, queryRaw } = setup();
    const { values } = await teach.review(teacher, "skill-1");
    expect(values).toEqual([
      {
        placeholder: "{{value 1}}",
        text: "ali@example.test",
        secret: false,
        suggestion: { name: "email" },
      },
      // The model took it for a password: a secret from now on.
      {
        placeholder: "{{value 2}}",
        text: "Gizli-5678",
        secret: true,
        suggestion: { name: "password" },
      },
      // A secret value gets no suggestion, even one the model made up.
      { placeholder: "{{value 3}}", text: null, secret: true },
    ]);
    // Only open values reach the model.
    expect(suggest).toHaveBeenCalledWith(teacher, expect.objectContaining({ botId: "bot-1" }), [
      { placeholder: "{{value 1}}", text: "ali@example.test" },
      { placeholder: "{{value 2}}", text: "Gizli-5678" },
    ]);
    // Written under the row's lock, only while it is a draft.
    expect(JSON.stringify(queryRaw.mock.calls[0])).toContain("FOR UPDATE");
    expect(executeRaw).toHaveBeenCalledOnce();
    expect(JSON.stringify(executeRaw.mock.calls[0])).toContain("dozoSuggestions");
  });

  it("reads cached suggestions instead of asking again, also an older cache", async () => {
    const cached = {
      "{{value 1}}": { name: "login", variable: false },
      "{{value 2}}": { name: "password", secret: true },
    };
    const { teach, suggest, executeRaw } = setup({
      row: { recording: { events, snapshots: [], dozoSuggestions: cached } },
    });
    const { values } = await teach.review(teacher, "skill-1");
    expect(values[0]).toMatchObject({ secret: false, suggestion: { name: "login" } });
    expect(values[1]).toMatchObject({ secret: true, suggestion: { name: "password" } });
    expect(values[2]?.suggestion).toBeUndefined();
    expect(suggest).not.toHaveBeenCalled();
    expect(executeRaw).not.toHaveBeenCalled();
  });

  it("caches a failed call too, so the model is not asked again", async () => {
    const failed = setup({ suggest: vi.fn(async () => null) });
    const { values } = await failed.teach.review(teacher, "skill-1");
    expect(values.every((value) => !value.suggestion)).toBe(true);
    expect(failed.executeRaw).toHaveBeenCalledOnce();
    expect(JSON.stringify(failed.executeRaw.mock.calls[0])).toContain('"{}"');

    const again = setup({ row: { recording: { events, snapshots: [], dozoSuggestions: {} } } });
    expect((await again.teach.review(teacher, "skill-1")).values).toHaveLength(3);
    expect(again.suggest).not.toHaveBeenCalled();

    const none = setup({ suggest: null });
    expect((await none.teach.review(teacher, "skill-1")).values).toHaveLength(3);
    expect(none.prisma.$transaction).not.toHaveBeenCalled();
  });

  it("keeps what another review wrote first, and writes nothing once the draft is gone", async () => {
    const first = { "{{value 1}}": { name: "login", secret: false } };
    const raced = setup({
      locked: [{ recording: { events, snapshots: [], dozoSuggestions: first } }],
    });
    const { values } = await raced.teach.review(teacher, "skill-1");
    expect(values[0]?.suggestion).toEqual({ name: "login" });
    expect(raced.suggest).toHaveBeenCalledOnce();
    expect(raced.executeRaw).not.toHaveBeenCalled();

    const saved = setup({ locked: [] });
    expect((await saved.teach.review(teacher, "skill-1")).values[0]?.suggestion).toEqual({
      name: "email",
    });
    expect(saved.executeRaw).not.toHaveBeenCalled();
  });

  it("gives nobody else the values, and none once saved or without typing", async () => {
    expect((await setup().teach.review(member, "skill-1")).values).toEqual([]);
    const saved = setup({ row: { status: "saved" } });
    expect((await saved.teach.review(teacher, "skill-1")).values).toEqual([]);
    const clicks = setup({ row: { recording: { events: [], snapshots: [] } } });
    expect((await clicks.teach.review(teacher, "skill-1")).values).toEqual([]);
    expect(clicks.suggest).not.toHaveBeenCalled();
  });

  it("refuses a skill of another Space", async () => {
    const { teach } = setup();
    await expect(
      teach.review({ ...teacher, spaceId: "space-2" }, "skill-1"),
    ).rejects.toBeInstanceOf(IsolationError);
  });
});

describe("save", () => {
  it("applies the decisions, then saves through the service", async () => {
    const { teach, taughtSkills } = setup();
    await teach.save(
      teacher,
      input({
        "{{value 1}}": { action: "fixed" },
        "{{value 2}}": { action: "variable", name: "password" },
      }),
    );
    const [, , draft] = taughtSkills.updateDraft.mock.calls[0] as unknown as [
      unknown,
      string,
      { playbook: SkillPlaybook; name: string },
    ];
    expect(draft.name).toBe("Sign in");
    expect(draft.playbook.steps).toEqual([
      'Type "ali@example.test".',
      "Press key: Tab.",
      "Type {{password}}.",
      "Press key: Tab.",
      "Type {{value_3}}.",
    ]);
    expect(draft.playbook.inputs).toEqual(["password (secret)", "value_3 (secret)"]);
    expect(JSON.stringify(draft)).not.toContain("Gizli-5678");
    expect(taughtSkills.save).toHaveBeenCalledWith(teacher, "skill-1", "Sign in");
    expect(taughtSkills.updateDraft.mock.invocationCallOrder[0]).toBeLessThan(
      taughtSkills.save.mock.invocationCallOrder[0]!,
    );
  });

  it("refuses to keep a secret value as text, also one the model took for a secret", async () => {
    const { teach, taughtSkills } = setup();
    await expect(
      teach.save(teacher, input({ "{{value 3}}": { action: "fixed" } })),
    ).rejects.toBeInstanceOf(ClientError);
    const flagged = setup({
      row: {
        recording: {
          events,
          snapshots: [],
          dozoSuggestions: { "{{value 2}}": { name: "password", secret: true } },
        },
      },
    });
    await expect(
      flagged.teach.save(teacher, input({ "{{value 2}}": { action: "fixed" } })),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    expect(taughtSkills.save).not.toHaveBeenCalled();
    expect(flagged.taughtSkills.save).not.toHaveBeenCalled();
  });

  it("refuses decisions for a skill already saved, and saves one without them as upstream", async () => {
    const saved = setup({ row: { status: "saved" } });
    for (const call of [saved.teach.save, saved.teach.test]) {
      await expect(
        call(teacher, input({ "{{value 1}}": { action: "variable", name: "email" } })),
      ).rejects.toMatchObject({ kind: "CONFLICT", code: SKILL_NOT_DRAFT });
    }
    expect(saved.taughtSkills.updateDraft).not.toHaveBeenCalled();
    await saved.teach.save(teacher, input());
    expect(saved.taughtSkills.updateDraft).toHaveBeenCalledWith(teacher, "skill-1", {
      name: "Sign in",
      playbook,
    });
  });

  it("lets someone else save without decisions, as upstream does", async () => {
    const { teach, taughtSkills } = setup();
    await teach.save(member, input());
    expect(taughtSkills.updateDraft).toHaveBeenCalledWith(member, "skill-1", {
      name: "Sign in",
      playbook,
    });
    await expect(
      teach.save(member, input({ "{{value 1}}": { action: "fixed" } })),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
  });
});

describe("test", () => {
  it("keeps the draft's placeholders and runs the prompt with the decisions applied", async () => {
    const { teach, taughtSkills } = setup({ row: { name: "Saved name" } });
    const result = await teach.test(teacher, {
      ...input({ "{{value 2}}": { action: "variable", name: "password" } }),
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
    expect(prompt).toContain("Type {{password}}.");
    expect(prompt).toContain("{{value_1}}");
    expect(prompt).not.toContain("Gizli-5678");
    expect(prompt).not.toContain("ali@example.test");
    expect(taughtSkills.save).not.toHaveBeenCalled();
  });

  it("names the run after the goal when the skill has no name", async () => {
    const { teach, taughtSkills } = setup();
    await teach.test(teacher, { ...input(), name: "" });
    const [, , prompt] = taughtSkills.testRun.mock.calls[0] as unknown as [unknown, string, string];
    expect(prompt).toContain("Run taught skill: Sign in");
  });
});

describe("the routes", () => {
  it("serve review, save and test for the signed-in member", async () => {
    const { prisma, taughtSkills } = setup();
    const suggest = vi.fn<TeachValueSuggester>(async () => ({}));
    const ctx = createRouterContext({
      prisma,
      events: { notify: () => undefined, publishSpaceChange: () => undefined },
      env: {},
      dozoTeach: { suggest },
    } as unknown as RouterDeps);
    const client = createRouterClient(dozoTeachRoutes({ ...ctx, taughtSkills } as never), {
      context: { actor: teacher },
    }).dozoTeach;
    expect((await client.review({ skillId: "skill-1" })).values).toHaveLength(3);
    expect(suggest).toHaveBeenCalledOnce();
    await client.save({ skillId: "skill-1", playbook });
    expect(taughtSkills.save).toHaveBeenCalledOnce();
    expect(await client.test({ skillId: "skill-1", playbook })).toEqual({ runId: "run-1" });
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
  });
});
