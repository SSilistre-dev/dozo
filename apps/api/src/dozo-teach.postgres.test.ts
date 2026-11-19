import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import type { JobPublisher } from "@rakazo/adapter-kit";
import type { TeachComputerInput, TeachingSessionDeps } from "@rakazo/adapters";
import {
  completeTeachingSession,
  createBackgroundJobHandlers,
  recordTeachingInputEvent,
} from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import { buildPlaybookFromRecording } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { asSystem, createDb, createThreadEvents, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaughtSkillsService } from "./dozo-taught-skills.js";
import { createDozoTeach } from "./dozo-teach.js";
import type { TeachClickLabeller } from "./dozo-teach-labels.js";
import type { TeachValueSuggester } from "./dozo-teach-suggest.js";

// Runs on the branded tree only, against a database migrated with `pnpm db:migrate` (DATABASE_URL
// is the runtime login row security applies to, the job queue's schema exists) and content
// encryption on: there the real recording, drafting and job paths run the fork's code through
// its anchored rules. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const PROTECTED = "S3cret-Pass!";
const TYPED = ["ali@example.test", "hunter2", "my secret phrase"];
// The pictures around two clicks: the first, and the one just before the protected paste.
const CROP = "Y3JvcC1vZi10aGUtZW1haWwtZmllbGQ";
const SECRET_CROP = "Y3JvcC1vZi10aGUtcGFzc3dvcmQtZmllbGQ";
// A title that shows something typed; only its application name is kept.
const TITLE = `${TYPED[0]} - Search – Browser`;
const WINDOW = "Browser";
const SCRUB = readFileSync(
  new URL(
    "../../../packages/db/prisma/migrations/20261230120100_dozo_teach_values/migration.sql",
    import.meta.url,
  ),
  "utf8",
).match(/WITH ev AS[\s\S]*?;/)?.[0];

describePostgres("typed values stay with the teacher, briefly (PostgreSQL)", () => {
  const id = `teach-${randomUUID()}`;
  const other = `${id}-bob`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;
  const teacher = { userId: id, spaceId: id, email: `${id}@example.test` } as Actor;
  const member = { userId: other, spaceId: id, email: `${other}@example.test` } as Actor;

  function deps(): TeachingSessionDeps {
    return {
      prisma: db.prisma,
      events: createThreadEvents(db.prisma),
      jobs: {
        enqueue: vi.fn(async () => undefined),
        cancel: vi.fn(async () => undefined),
      } as unknown as JobPublisher,
      sandbox: {} as never,
    };
  }

  beforeAll(async () => {
    db = createDb(databaseUrl!, { encryptContent: true });
    system = asSystem(db.prisma);
    const createdAt = new Date();
    for (const user of [id, other]) {
      await system.user.create({
        data: { id: user, name: user, email: `${user}@example.test`, emailVerified: true },
      });
    }
    await system.organization.create({ data: { id, name: "Team", slug: id, createdAt } });
    await system.member.createMany({
      data: [
        { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
        { id: `m-${other}`, organizationId: id, userId: other, role: "member", createdAt },
      ],
    });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id: { in: [id, other] } } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  /** A recording made through the real input path, then stopped as the Stop button does. */
  async function recordAndStop() {
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Clerk", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: id, botId: bot.id, userId: id },
    });
    const skill = await system.taughtSkill.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        goal: "Sign in",
        status: "recording",
        startedAt: new Date(),
        expiresAt: new Date(Date.now() + 600_000),
        recording: { events: [], snapshots: [] } as never,
      },
    });
    const inputs: TeachComputerInput[] = [
      { kind: "pointer", x: 10, y: 20, button: "left", type: "click" },
      ...TYPED.flatMap((text): TeachComputerInput[] => [
        ...[...text].map((key): TeachComputerInput => ({ kind: "key", key })),
        { kind: "key", key: "Tab" },
      ]),
      { kind: "pointer", x: 30, y: 40, button: "left", type: "click" },
      { kind: "clipboard", text: PROTECTED, sensitive: true, skillId: skill.id },
      { kind: "key", key: "Enter" },
    ];
    for (const input of inputs) {
      expect(
        await runAsTenant(teacher, () => recordTeachingInputEvent(deps(), teacher, bot.id, input)),
      ).toBe("recorded");
    }
    // Protected input never reaches the recording, even while it is recording.
    const [live] = await system.$queryRaw<Array<{ recording: string; count: number }>>`
      SELECT recording::text AS recording, jsonb_array_length(recording->'events') AS count
      FROM taught_skills WHERE id = ${skill.id}`;
    expect(live?.count).toBe(inputs.length);
    expect(live?.recording).not.toContain(PROTECTED);
    // What the clicks hit, as the capture keeps it while recording (no computer runs here).
    const secretClick = inputs.length - 3;
    await system.$executeRaw`
      UPDATE taught_skills SET recording = recording || jsonb_build_object('dozoTargets',
        ${JSON.stringify([
          { eventIndex: 0, window: TITLE, image: CROP },
          { eventIndex: secretClick, window: TITLE, image: SECRET_CROP },
        ])}::jsonb)
      WHERE id = ${skill.id}`;
    await runAsTenant(teacher, () => completeTeachingSession(deps(), teacher, skill.id, "stopped"));
    return { bot, thread, skill };
  }

  /** Everything stored about the skill that is not the values store, read as its readers do. */
  async function storedText(skillId: string, threadId: string) {
    const [raw] = await system.$queryRaw<Array<{ playbook: string; recording: string }>>`
      SELECT playbook::text AS playbook, recording::text AS recording
      FROM taught_skills WHERE id = ${skillId}`;
    // Through the client, which opens content sealed at rest (blocks, payloads).
    const [messages, events, tasks] = await Promise.all([
      system.message.findMany({ where: { threadId } }),
      system.event.findMany({ where: { threadId } }),
      system.task.findMany({ where: { threadId } }),
    ]);
    return {
      skill: `${raw?.playbook}\n${raw?.recording}`,
      blocks: JSON.stringify(messages.map((message) => message.blocks)),
      payloads: JSON.stringify(events.map((event) => event.payload)),
      prompts: tasks.map((task) => task.prompt).join("\n"),
    };
  }

  async function valuesRow(skillId: string) {
    const [row] = await system.$queryRaw<
      Array<{ values: string; targets: string | null; expiresAt: Date }>
    >`
      SELECT "values", "targets", "expiresAt" FROM dozo_teach_values WHERE "skillId" = ${skillId}`;
    return row;
  }

  /** Every row of every table that could hold a picture of the skill, as text. */
  async function everyRow(skillId: string, threadId: string) {
    const [raw] = await system.$queryRaw<Array<{ text: string }>>`
      SELECT concat_ws(E'\n',
        (SELECT string_agg(t::text, E'\n') FROM taught_skills t WHERE t.id = ${skillId}),
        (SELECT string_agg(v::text, E'\n') FROM dozo_teach_values v WHERE v."skillId" = ${skillId}),
        (SELECT string_agg(j::text, E'\n') FROM graphile_worker.jobs j),
        (SELECT string_agg(m::text, E'\n') FROM messages m WHERE m."threadId" = ${threadId}),
        (SELECT string_agg(e::text, E'\n') FROM events e WHERE e."threadId" = ${threadId}),
        (SELECT string_agg(k::text, E'\n') FROM tasks k WHERE k."threadId" = ${threadId})
      ) AS text`;
    return `${raw?.text ?? ""}\n${Object.values(await storedText(skillId, threadId)).join("\n")}`;
  }

  it("keeps nothing typed after an abandoned draft, and forgets the values when due", async () => {
    const { thread, skill } = await recordAndStop();
    const drafted = await system.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(drafted.status).toBe("draft");

    const stored = await storedText(skill.id, thread.id);
    expect(stored.blocks).toContain("{{value 2}}");
    for (const text of [...TYPED, PROTECTED, CROP, SECRET_CROP]) {
      for (const place of Object.values(stored)) expect(place).not.toContain(text);
    }
    // The clicks keep their window; their pictures left the recording.
    const targets = (drafted.recording as { dozoTargets: Array<Record<string, unknown>> })
      .dozoTargets;
    expect(targets.map((target) => target.window)).toEqual([WINDOW, WINDOW]);
    expect(targets.some((target) => "image" in target)).toBe(false);
    // One event per value: neither the characters, their number nor their timing is left.
    const events = (drafted.recording as { events: Array<Record<string, unknown>> }).events;
    expect(events.filter((event) => event.typed)).toHaveLength(4);
    expect(
      events.filter((event) => typeof event.key === "string" && event.key.length === 1),
    ).toEqual([]);
    expect(buildPlaybookFromRecording("Sign in", events as never).steps).toEqual(
      (drafted.playbook as { steps: string[] }).steps,
    );

    // The values wait sealed with the Space's key, due in 24 hours on the queue.
    const row = await valuesRow(skill.id);
    expect(row?.values.startsWith("rkz1:")).toBe(true);
    for (const text of TYPED) expect(row?.values).not.toContain(text);
    expect(row?.targets?.startsWith("rkz1:")).toBe(true);
    expect(row?.targets).not.toContain(CROP);
    const hours = (row!.expiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);
    const jobs = await system.$queryRaw<Array<{ task_identifier: string; run_at: Date }>>`
      SELECT task_identifier, run_at FROM graphile_worker.jobs
      WHERE key = ${`dozo.teach-values:${skill.id}`}`;
    expect(jobs).toEqual([{ task_identifier: "skill.teaching-expire", run_at: row!.expiresAt }]);

    // Only the teacher reviews them; the model is told shapes, never a value.
    const suggest = vi.fn<TeachValueSuggester>(async () => ({ "{{value 1}}": { name: "email" } }));
    const taughtSkills = createTaughtSkillsService({
      ...deps(),
      home: {},
      dataDir: "/tmp",
    } as never);
    const label = vi.fn<TeachClickLabeller>(async () => ({}));
    const teach = createDozoTeach({ prisma: db.prisma, taughtSkills, suggest, label });
    const review = await runAsTenant(teacher, () => teach.review(teacher, skill.id));
    // The teacher sees the first click's picture; none was kept of the one before protected input,
    // and no picture went to the model.
    expect(review.targets.map((target) => target.image)).toEqual([
      `data:image/webp;base64,${CROP}`,
      undefined,
    ]);
    expect(label).not.toHaveBeenCalled();
    expect((await runAsTenant(member, () => teach.review(member, skill.id))).targets).toEqual([]);
    expect(review.values.map((value) => [value.text, value.secret])).toEqual([
      [TYPED[0], false],
      [TYPED[1], false],
      [TYPED[2], false],
      [null, true],
    ]);
    for (const text of [...TYPED, PROTECTED]) {
      expect(JSON.stringify(suggest.mock.calls)).not.toContain(text);
    }
    expect((await runAsTenant(member, () => teach.review(member, skill.id))).values).toEqual([]);
    // Another member reads the skill without its recording, and nothing typed in it either way.
    const seen = JSON.stringify([
      await runAsTenant(member, () => taughtSkills.get(member, skill.id)),
      await runAsTenant(member, () => taughtSkills.list(member, skill.botId)),
    ]);
    for (const text of [...TYPED, PROTECTED]) expect(seen).not.toContain(text);

    // The queue's job, once due, forgets them through the real handler.
    await system.$executeRaw`
      UPDATE dozo_teach_values SET "expiresAt" = CURRENT_TIMESTAMP - interval '1 second'
      WHERE "skillId" = ${skill.id}`;
    const handlers = createBackgroundJobHandlers(deps() as never);
    await handlers["skill.teaching-expire"]({ skillId: skill.id });
    expect(await valuesRow(skill.id)).toBeUndefined();
    expect(await runAsTenant(teacher, () => teach.review(teacher, skill.id))).toEqual({
      values: [],
      targets: [],
    });
    // An abandoned draft keeps no picture anywhere once due.
    const left = await everyRow(skill.id, thread.id);
    expect(left).not.toContain(CROP);
    expect(left).not.toContain(SECRET_CROP);
  });

  it("saves the decisions and forgets the values in one transaction", async () => {
    const { thread, skill } = await recordAndStop();
    const taughtSkills = createTaughtSkillsService({
      ...deps(),
      home: {},
      dataDir: "/tmp",
    } as never);
    // Labels are asked at the save, only for the picture the teacher kept.
    const label = vi.fn<TeachClickLabeller>(async () => ({ "0": "Email field" }));
    const teach = createDozoTeach({ prisma: db.prisma, taughtSkills, label });
    const drafted = await system.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    const draft = {
      skillId: skill.id,
      name: "Sign in",
      playbook: drafted.playbook as never,
      decisions: {
        "{{value 1}}": { action: "variable" as const, name: "email" },
        "{{value 2}}": { action: "hidden" as const, name: "password" },
      },
    };
    // A test run writes the applied playbook into its task; then the save.
    await runAsTenant(teacher, () => teach.test(teacher, draft));
    // Someone else cannot decide about the values.
    await expect(runAsTenant(member, () => teach.save(member, draft))).rejects.toMatchObject({
      kind: "FORBIDDEN",
    });
    expect(await valuesRow(skill.id)).toBeDefined();
    await runAsTenant(teacher, () => teach.save(teacher, draft));

    expect(await valuesRow(skill.id)).toBeUndefined();
    expect(label).toHaveBeenCalledOnce();
    expect(label.mock.calls[0]?.[2]).toEqual([{ id: "0", image: CROP }]);
    const saved = await system.taughtSkill.findUniqueOrThrow({ where: { id: skill.id } });
    expect(saved.status).toBe("saved");
    expect((saved.playbook as { steps: string[] }).steps[0]).toBe(
      `Click "Email field" in "${WINDOW}" (near 10, 20).`,
    );
    expect((saved.playbook as { steps: string[] }).steps).toContain(
      "Click left button at (30, 40).",
    );
    expect(saved.recording).not.toHaveProperty("dozoTargets");
    const everything = await everyRow(skill.id, thread.id);
    expect(everything).not.toContain(CROP);
    expect(everything).not.toContain(SECRET_CROP);
    expect((saved.playbook as { inputs: string[] }).inputs).toEqual([
      "Sign in",
      "email",
      "password (secret)",
      "value_3",
      "value_4 (secret)",
    ]);
    const stored = await storedText(skill.id, thread.id);
    expect(stored.blocks).toContain("{{password}}");
    expect(stored.prompts).toContain("{{password}}");
    for (const text of [...TYPED, PROTECTED]) {
      for (const place of Object.values(stored)) expect(place).not.toContain(text);
    }
    expect((await runAsTenant(teacher, () => teach.review(teacher, skill.id))).values).toEqual([]);
  });

  it("migrates older drafts and saved skills to one event per typed run, live ones untouched", async () => {
    expect(SCRUB).toBeDefined();
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Old", color: "test" },
    });
    const at = (n: number) => `2026-01-01T00:00:0${n}.000Z`;
    const old = [
      { at: at(0), kind: "pointer", x: 1, y: 1, type: "click" },
      { at: at(1), kind: "key", key: "h" },
      { at: at(2), kind: "key", key: "Backspace" },
      { at: at(3), kind: "clipboard", text: "hunter2" },
      { at: at(4), kind: "key", key: "Tab" },
      { at: at(5), kind: "key", sensitive: true },
      { at: at(6), kind: "key", key: "Enter" },
      { at: at(7), kind: "key", key: "Backspace" },
      { at: at(8), kind: "snapshot", summary: "Done" },
    ];
    const rows = [];
    for (const status of ["draft", "drafting", "saved", "recording"]) {
      rows.push(
        await system.taughtSkill.create({
          data: {
            spaceId: id,
            botId: bot.id,
            userId: id,
            goal: status,
            status,
            recording: {
              events: old,
              snapshots: [],
              dozoSuggestions: { "{{value 1}}": { name: "x" } },
            } as never,
          },
        }),
      );
    }
    await system.$executeRawUnsafe(SCRUB!);
    const after = await system.taughtSkill.findMany({
      where: { id: { in: rows.map((r) => r.id) } },
    });
    for (const row of after) {
      const recording = row.recording as { events: unknown[]; dozoSuggestions?: unknown };
      if (row.status === "recording") {
        expect(recording.events).toEqual(old);
        continue;
      }
      expect(recording.dozoSuggestions).toBeUndefined();
      expect(recording.events).toEqual([
        old[0],
        { at: at(1), kind: "key", typed: true },
        old[4],
        { at: at(5), kind: "key", typed: true, sensitive: true },
        old[6],
        old[7],
        old[8],
      ]);
    }
  });
});
