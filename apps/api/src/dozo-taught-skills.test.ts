import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import type { SkillPlaybook, TeachRecordingEvent } from "@rakazo/core";
import { buildPlaybookFromRecording, ClientError, typedValuesFromRecording } from "@rakazo/core";
import { IsolationError } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const allowance = vi.hoisted(() => ({ usedUp: vi.fn(async () => false) }));
const upstream = vi.hoisted(() => ({
  start: vi.fn(async () => ({ id: "skill-1" })),
  updateDraft: vi.fn(async () => ({ id: "skill-1", status: "saved" })),
  list: vi.fn(async () => ["listed"]),
  get: vi.fn(async () => "got"),
}));

vi.mock("@rakazo/adapters", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  sandboxAllowanceUsedUp: allowance.usedUp,
}));
vi.mock("./taught-skills.js", () => ({ createTaughtSkillsService: () => upstream }));

const { createTaughtSkillsService, forgetOldTeachTyping, FORGET_PAGE, SKILL_NOT_DRAFT } =
  await import("./dozo-taught-skills.js");

const actor = { userId: "ada", spaceId: "space-1", email: "ada@example.test" } as never;

function setup(computer: Record<string, unknown> | null, provisionKind?: () => Promise<string>) {
  const runs = { updateManyAndReturn: vi.fn() };
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-1", computer })) },
    run: runs,
  };
  const service = createTaughtSkillsService({
    prisma,
    sandbox: { provisionKind },
  } as never);
  return { service, prisma, runs };
}

const stopped = {
  spaceId: "space-1",
  kind: "docker",
  homeKey: "home-1",
  state: "stopped",
  providerRef: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  allowance.usedUp.mockResolvedValue(false);
});

describe("start", () => {
  it("refuses a plan with no computer time left before anything is cancelled", async () => {
    allowance.usedUp.mockResolvedValue(true);
    const { service, runs } = setup(stopped, async () => "cloud");
    await expect(service.start(actor, "bot-1", "Sign in")).rejects.toBeInstanceOf(
      SandboxAllowanceUsedError,
    );
    expect(allowance.usedUp).toHaveBeenCalledWith(expect.anything(), {
      spaceId: "space-1",
      kind: "cloud",
    });
    expect(upstream.start).not.toHaveBeenCalled();
    expect(runs.updateManyAndReturn).not.toHaveBeenCalled();
  });

  it("starts as upstream does when time is left, the computer runs or there is none", async () => {
    await setup(stopped).service.start(actor, "bot-1", "Sign in");
    expect(allowance.usedUp).toHaveBeenCalledWith(expect.anything(), {
      spaceId: "space-1",
      kind: "docker",
    });
    allowance.usedUp.mockResolvedValue(true);
    await setup({ ...stopped, state: "running", providerRef: "ref" }).service.start(
      actor,
      "bot-1",
      "Sign in",
    );
    await setup(null).service.start(actor, "bot-1", "Sign in");
    expect(upstream.start).toHaveBeenCalledTimes(3);
    expect(allowance.usedUp).toHaveBeenCalledOnce();
  });
});

const at = "2026-01-01T00:00:00.000Z";
const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at, kind: "key", key }));
const events: TeachRecordingEvent[] = [
  ...typing("ali@example.test"),
  { at, kind: "key", key: "Tab" },
  ...typing("hunter2"),
  { at, kind: "key", key: "Tab" },
  { at, kind: "clipboard", sensitive: true },
];
const playbook = buildPlaybookFromRecording("Sign in", events);
const member = { userId: "bob", spaceId: "space-1", email: "bob@example.test" } as never;

/** A draft whose recording was never scrubbed (drafted by an older release), and its values. */
function saving(
  options: { skill?: Record<string, unknown>; stored?: Record<string, unknown> | null } = {},
) {
  const skill = {
    id: "skill-1",
    spaceId: "space-1",
    userId: "ada",
    botId: "bot-1",
    name: "",
    goal: "Sign in",
    status: "draft",
    playbook,
    recording: {
      events,
      snapshots: [{ at, summary: "ali@example.test - Inbox - Mail" }],
      controlLeaseId: "lease-1",
    },
    ...options.skill,
  };
  const stored =
    options.stored === null
      ? null
      : {
          skillId: "skill-1",
          spaceId: "space-1",
          userId: "ada",
          values: JSON.stringify(typedValuesFromRecording(events)),
          suggestions: null,
          due: false,
          ...options.stored,
        };
  const steps: string[] = [];
  const update = vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
    steps.push("update");
    return { ...skill, ...data };
  });
  const tx = {
    $executeRaw: vi.fn(async () => {
      steps.push("lock");
      return 1;
    }),
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      // The values are forgotten past row security: any save forgets them.
      if (/current_setting|set_config/.test(strings.join("?"))) return [{}];
      expect(strings.join("?")).toContain('DELETE FROM "dozo_teach_values"');
      steps.push("forget values");
      return stored ? [stored] : [];
    }),
    taughtSkill: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) =>
        where.id === skill.id && where.spaceId === skill.spaceId ? skill : null,
      ),
      update,
    },
  };
  const append = vi.fn(async () => undefined);
  const prisma = {
    $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => {
      const result = await work(tx);
      steps.push("commit");
      return result;
    }),
    bot: { findUnique: vi.fn(async () => ({ id: "bot-1", thread: { id: "thread-1" } })) },
  };
  upstream.updateDraft.mockImplementation(async () => {
    steps.push("card");
    return { id: "skill-1", status: "saved" };
  });
  const service = createTaughtSkillsService({ prisma, events: { append } } as never);
  const written = () =>
    update.mock.calls[0]![0].data as {
      userId: string;
      status: string;
      name: string;
      playbook: SkillPlaybook;
      recording: { events: TeachRecordingEvent[]; snapshots: Array<{ summary: string }> };
    };
  return { service, steps, written, append, update };
}

describe("save", () => {
  it("applies the decisions, forgets the values and scrubs the recording in one transaction", async () => {
    const { service, steps, written, append } = saving();
    const saved = await service.save(actor, "skill-1", "Sign in", {
      playbook,
      decisions: {
        "{{value 1}}": { action: "fixed" },
        "{{value 2}}": { action: "hidden", name: "password" },
      },
    });
    expect(saved).toEqual({ id: "skill-1", status: "saved" });
    expect(steps).toEqual(["lock", "forget values", "update", "commit", "card"]);
    const data = written();
    expect(data).toMatchObject({ userId: "ada", status: "saved", name: "Sign in" });
    expect(data.playbook.steps).toEqual([
      'Type "ali@example.test".',
      "Press key: Tab.",
      "Type {{password}}.",
      "Press key: Tab.",
      "Type {{value_3}}.",
    ]);
    expect(data.playbook.inputs).toEqual(["Sign in", "password (secret)", "value_3 (secret)"]);
    expect(JSON.stringify(data)).not.toContain("hunter2");
    expect(data.recording.events.filter((event) => event.key?.length === 1)).toEqual([]);
    expect(data.recording).toMatchObject({
      controlLeaseId: "lease-1",
      snapshots: [{ at, summary: "Mail" }],
      dozoScrubbed: true,
    });
    // The card and the thread follow the commit with what was saved.
    expect(upstream.updateDraft).toHaveBeenCalledWith(actor, "skill-1", {
      name: "Sign in",
      playbook: data.playbook,
    });
    expect(append).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "skill.saved",
        threadId: "thread-1",
        payload: { skillId: "skill-1", name: "Sign in" },
      }),
    );
  });

  it("makes every undecided value an input when saved without decisions", async () => {
    const { service, written } = saving({ skill: { name: "Old" } });
    await service.save(actor, "skill-1");
    expect(written().name).toBe("Old");
    expect(written().playbook.inputs).toEqual([
      "Sign in",
      "value_1",
      "value_2",
      "value_3 (secret)",
    ]);
  });

  it("refuses to keep a protected value as text, and writes nothing", async () => {
    const { service, update } = saving();
    await expect(
      service.save(actor, "skill-1", undefined, {
        playbook,
        decisions: { "{{value 3}}": { action: "fixed" } },
      }),
    ).rejects.toBeInstanceOf(ClientError);
    expect(update).not.toHaveBeenCalled();
    expect(upstream.updateDraft).not.toHaveBeenCalled();
  });

  it("lets someone else save without decisions, without the recording, values forgotten", async () => {
    const { service, steps, written } = saving();
    await expect(
      service.save(member, "skill-1", undefined, {
        playbook,
        decisions: { "{{value 1}}": { action: "fixed" } },
      }),
    ).rejects.toMatchObject({ kind: "FORBIDDEN" });
    await service.save(member, "skill-1");
    expect(steps).toContain("forget values");
    expect(written()).toMatchObject({ userId: "bob", playbook });
    expect(written().recording).toEqual({ events: [], snapshots: [] });
  });

  it("refuses decisions for a saved skill, and saves one without them", async () => {
    const decided = {
      playbook,
      decisions: { "{{value 1}}": { action: "variable" as const, name: "email" } },
    };
    await expect(
      saving({ skill: { status: "saved" } }).service.save(actor, "skill-1", undefined, decided),
    ).rejects.toMatchObject({ kind: "CONFLICT", code: SKILL_NOT_DRAFT });
    const saved = saving({ skill: { status: "saved" } });
    await saved.service.save(actor, "skill-1");
    expect(saved.written().playbook).toEqual(playbook);
  });

  it("ignores values that are due or another person's", async () => {
    for (const stored of [{ due: true }, { userId: "bob" }]) {
      const { service, written } = saving({ stored });
      await service.save(actor, "skill-1");
      expect(written().playbook).toEqual(playbook);
    }
    const none = saving({ stored: null });
    await none.service.save(actor, "skill-1");
    expect(none.written().playbook).toEqual(playbook);
  });

  it("refuses a recording and a skill of another Space", async () => {
    await expect(
      saving({ skill: { status: "recording" } }).service.save(actor, "skill-1"),
    ).rejects.toMatchObject({ kind: "BAD_REQUEST" });
    await expect(
      saving({ skill: { spaceId: "space-2" } }).service.save(actor, "skill-1"),
    ).rejects.toBeInstanceOf(IsolationError);
  });

  it("says what each kept click hit and keeps no picture, label or window of the rest", async () => {
    const click = (x: number, y: number): TeachRecordingEvent => ({
      at,
      kind: "pointer",
      x,
      y,
      type: "click",
    });
    // Clicks at 0 (before the email), 18 (before hunter2), 27 (before the protected paste), 29.
    const clicked: TeachRecordingEvent[] = [
      click(10, 20),
      ...events.slice(0, 17),
      click(30, 40),
      ...events.slice(17, 25),
      click(50, 60),
      events[25]!,
      click(70, 80),
    ];
    const clickedPlaybook = buildPlaybookFromRecording("Sign in", clicked);
    const window = "Sign in – Browser";
    const { service, written } = saving({
      skill: {
        playbook: clickedPlaybook,
        recording: {
          events: clicked,
          snapshots: [],
          dozoTargets: [0, 18, 27, 29].map((eventIndex) => ({ eventIndex, window })),
        },
      },
      stored: { values: JSON.stringify(typedValuesFromRecording(clicked)) },
    });
    await service.save(actor, "skill-1", "Sign in", {
      playbook: clickedPlaybook,
      decisions: { "{{value 2}}": { action: "hidden", name: "password" } },
      removedTargets: ["29"],
      labels: { "0": "Email field", "18": "Password field", "29": "Done" },
    });
    expect(written().playbook.steps.filter((step) => step.includes("near"))).toEqual([
      `Click "Email field" in "${window}" (near 10, 20).`,
    ]);
    expect(written().playbook.steps).toContain("Click left button at (30, 40).");
    expect(written().playbook.steps).toContain("Click left button at (50, 60).");
    expect(written().playbook.steps).toContain("Click left button at (70, 80).");
    expect(written().recording).not.toHaveProperty("dozoTargets");
  });

  it("leaves a recording forgotten when drafted as it is", async () => {
    const forgotten = { events: [], snapshots: [{ at, summary: "Mail" }], dozoScrubbed: true };
    const { service, written } = saving({ skill: { recording: forgotten } });
    await service.save(actor, "skill-1");
    expect(written().recording).toEqual(forgotten);
  });

  it("keeps upstream's other procedures", () => {
    expect(setup(null).service.updateDraft).toBe(upstream.updateDraft);
  });
});

describe("forgetOldTeachTyping", () => {
  /** Skills as the previous release left them, by id, and what the forgetting wrote. */
  function old(rows: Record<string, Record<string, unknown> | null>, found = Object.keys(rows)) {
    const written: Array<{ id: unknown; recording: Record<string, unknown> }> = [];
    const steps: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...params: unknown[]) => {
        const text = strings.join("?");
        if (text.includes("FOR UPDATE")) steps.push(`lock ${params[0]}`);
        else written.push({ id: params[1], recording: JSON.parse(params[0] as string) });
        return 1;
      }),
      taughtSkill: {
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => rows[where.id]),
      },
    };
    const prisma = {
      $queryRaw: vi.fn(async () => found.map((id) => ({ id }))),
      $transaction: vi.fn(async (work: (client: typeof tx) => Promise<unknown>) => work(tx)),
    };
    return { prisma, written, steps };
  }

  const left = {
    status: "draft",
    recording: {
      events: [...events, { at, kind: "snapshot", summary: "hunter2 - Search - Browser" }],
      snapshots: [
        { at, summary: "hunter2 - Search - Browser" },
        { at, summary: "hunter2" },
      ],
      controlLeaseId: "lease-1",
      dozoSuggestions: {},
    },
  };

  it("keeps one event per typed run and only application names, under the row lock", async () => {
    const { prisma, written, steps } = old({ "skill-1": left });
    expect(await forgetOldTeachTyping(prisma as never, { spaceId: "space-1" })).toBe(1);
    expect(steps).toEqual(["lock skill-1"]);
    expect(written).toHaveLength(1);
    const [{ id, recording }] = written as [(typeof written)[number]];
    expect(id).toBe("skill-1");
    expect(JSON.stringify(recording)).not.toMatch(/hunter2|ali@example/);
    expect(recording).toMatchObject({
      snapshots: [{ at, summary: "Browser" }],
      controlLeaseId: "lease-1",
      dozoScrubbed: true,
    });
    expect(recording).not.toHaveProperty("dozoSuggestions");
    expect(buildPlaybookFromRecording("x", recording.events as never).steps).toEqual(
      buildPlaybookFromRecording("x", left.recording.events as never).steps,
    );
    // Only skills of the scope that still hold something, a page at a time.
    const [strings, ...params] = prisma.$queryRaw.mock.calls[0] as unknown as [
      TemplateStringsArray,
      ...unknown[],
    ];
    const query = strings.join("?");
    expect(query).toContain("status <> 'recording'");
    expect(query).toContain("dozoScrubbed");
    expect(params).toEqual([null, null, "space-1", "space-1", null, null, FORGET_PAGE]);
  });

  it("leaves a skill that became live, was forgotten meanwhile or went", async () => {
    const { prisma, written } = old({
      a: { ...left, status: "recording" },
      b: { ...left, recording: { ...left.recording, dozoScrubbed: true } },
      c: null,
    });
    expect(await forgetOldTeachTyping(prisma as never, {})).toBe(3);
    expect(written).toEqual([]);
  });

  it("is what reading skills does first", async () => {
    const { prisma } = old({});
    const service = createTaughtSkillsService({ prisma } as never);
    expect(await service.list(actor, "bot-1")).toEqual(["listed"]);
    expect(await service.get(actor, "skill-1")).toBe("got");
    const scopes = prisma.$queryRaw.mock.calls.map((call) => (call as unknown[]).slice(1, 7));
    expect(scopes).toEqual([
      [null, null, "space-1", "space-1", "bot-1", "bot-1"],
      ["skill-1", "skill-1", "space-1", "space-1", null, null],
    ]);
    expect(upstream.list).toHaveBeenCalledWith(actor, "bot-1");
    expect(upstream.get).toHaveBeenCalledWith(actor, "skill-1");
  });
});
