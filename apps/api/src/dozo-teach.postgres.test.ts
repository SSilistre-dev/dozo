import { randomUUID } from "node:crypto";
import type { Actor } from "@rakazo/contracts";
import type { TeachRecordingEvent } from "@rakazo/core";
import { buildPlaybookFromRecording, typedValuesFromRecording } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createThreadEvents,
  draftTeachingRecordingInTransaction,
  runAsTenant,
} from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTaughtSkillsService } from "./dozo-taught-skills.js";
import { createDozoTeach } from "./dozo-teach.js";

// Runs on the branded tree only, against a migrated database (DATABASE_URL, the runtime login row
// security applies to): there `@rakazo/core` serves the fork's playbook builder, which the real
// drafting path in `@rakazo/db` calls. The fork's unit gate has no database and skips it.

const databaseUrl = process.env.DATABASE_URL;
const describePostgres = process.env.VERIFY_DATABASE && databaseUrl ? describe : describe.skip;

const PASSWORD = "Gizli-5678";
const at = "2026-11-19T12:00:00.000Z";
const typing = (text: string): TeachRecordingEvent[] =>
  [...text].map((key) => ({ at, kind: "key", key }));

describePostgres("typed values never stay in a saved skill (PostgreSQL)", () => {
  const id = `teach-${randomUUID()}`;
  let db: ReturnType<typeof createDb>;
  let system: PrismaClient;

  beforeAll(async () => {
    db = createDb(databaseUrl!);
    system = asSystem(db.prisma);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    await system.space.create({ data: { id, organizationId: id, name: "Home" } });
  });

  afterAll(async () => {
    await system.organization.deleteMany({ where: { id } });
    await system.user.deleteMany({ where: { id } });
    await db.prisma.$disconnect();
    await db.pool.end();
  });

  it("drafts with placeholders and forgets the typed text on save", async () => {
    // The package export is the fork's builder, so the drafting path below runs it.
    expect(
      buildPlaybookFromRecording("x", typing("a")).steps.some((step) => step.includes("{{")),
    ).toBe(true);
    const bot = await system.bot.create({
      data: { spaceId: id, userId: id, name: "Clerk", color: "test" },
    });
    const thread = await system.thread.create({
      data: { spaceId: id, botId: bot.id, userId: id },
    });
    const events: TeachRecordingEvent[] = [
      { at, kind: "pointer", x: 10, y: 20, type: "click" },
      ...typing("ali@example.test"),
      { at, kind: "key", key: "Tab" },
      ...typing(PASSWORD),
      { at, kind: "key", key: "Tab" },
      { at, kind: "pointer", x: 30, y: 40, type: "click" },
      { at, kind: "key", sensitive: true },
      { at, kind: "key", sensitive: true },
      { at, kind: "key", key: "Enter" },
    ];
    // What each click hit: a picture for the first, and one for the click before the protected run.
    const secretClick = events.findIndex((event) => event.x === 30);
    const targets = [
      { eventIndex: 0, window: "Form – Browser", image: "AAAA" },
      { eventIndex: secretClick, window: "Form – Browser", image: "BBBB" },
    ];
    const recording = await system.taughtSkill.create({
      data: {
        spaceId: id,
        botId: bot.id,
        userId: id,
        goal: "Sign in",
        status: "recording",
        recording: { events, snapshots: [], dozoTargets: targets } as never,
      },
    });
    await system.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT id FROM taught_skills WHERE id = ${recording.id} FOR UPDATE`;
      await draftTeachingRecordingInTransaction(tx, recording, { spaceId: id, reason: "stopped" });
    });

    const actor = { userId: id, spaceId: id, email: `${id}@example.test` } as Actor;
    const taughtSkills = createTaughtSkillsService({
      prisma: db.prisma,
      events: createThreadEvents(db.prisma),
      jobs: { enqueue: vi.fn(), cancel: vi.fn() },
      sandbox: {},
      home: {},
      dataDir: "/tmp",
    } as never);
    const teach = createDozoTeach({ prisma: db.prisma, taughtSkills });
    const drafted = await system.taughtSkill.findUniqueOrThrow({ where: { id: recording.id } });
    // Drafting dropped the picture of the click before protected input, and kept its window.
    expect((drafted.recording as { dozoTargets: unknown }).dozoTargets).toEqual([
      targets[0],
      { eventIndex: secretClick, window: "Form – Browser" },
    ]);
    const values = typedValuesFromRecording(events);
    const password = values.find((value) => value.text === PASSWORD)!.placeholder;
    // Before the save only the teacher's review holds the text.
    const review = await runAsTenant(actor, () => teach.review(actor, recording.id));
    expect(review.values.map((value) => value.text)).toEqual(["ali@example.test", PASSWORD, null]);
    expect(review.targets.map((target) => [target.id, target.image])).toEqual([
      ["0", "data:image/webp;base64,AAAA"],
      [String(secretClick), undefined],
    ]);

    const draft = {
      skillId: recording.id,
      name: "Sign in",
      playbook: drafted.playbook as never,
      decisions: { [password]: { action: "variable" as const, name: "password" } },
    };
    // A test run writes the applied playbook into its task; then the save.
    await runAsTenant(actor, () => teach.test(actor, draft));
    await runAsTenant(actor, () => teach.save(actor, draft));

    // Read through the client, which opens content sealed at rest (blocks, payloads): a scan of
    // the raw columns would find nothing in ciphertext whatever they held.
    const [skill, messages, rows, tasks] = await Promise.all([
      system.taughtSkill.findUniqueOrThrow({ where: { id: recording.id } }),
      system.message.findMany({ where: { threadId: thread.id } }),
      system.event.findMany({ where: { threadId: thread.id } }),
      system.task.findMany({ where: { threadId: thread.id } }),
    ]);
    const blocks = JSON.stringify(messages.map((message) => message.blocks));
    const payloads = JSON.stringify(rows.map((row) => row.payload));
    const prompts = tasks.map((task) => task.prompt).join("\n");
    expect(blocks).toContain("skill_draft");
    expect(blocks).toContain("{{password}}");
    expect(payloads).toContain("{{value 2}}");
    expect(prompts).toContain("{{password}}");
    const stored = [JSON.stringify(skill.playbook), blocks, payloads, prompts].join("\n");
    expect(stored).not.toContain(PASSWORD);
    expect(stored).not.toContain("ali@example.test");
    // The recording holds one key per event: neither the joined keys nor any text is left.
    const kept = skill.recording as { events: Array<{ key?: string; text?: string }> };
    expect(kept.events).toHaveLength(events.length);
    expect(kept.events.map((event) => `${event.key ?? ""}${event.text ?? ""}`).join("")).toBe("");
    expect(JSON.stringify(kept)).not.toContain(PASSWORD);
    expect(skill.status).toBe("saved");
    // No picture outlives the save; what the clicks hit stays in their steps.
    expect(JSON.stringify(skill.recording)).not.toContain("AAAA");
    expect(JSON.stringify(skill.recording)).not.toContain("BBBB");
    expect(JSON.stringify(skill.recording)).not.toContain('"image"');
    expect((skill.recording as Record<string, unknown>).dozoTargets).toBeUndefined();
    expect((skill.playbook as { steps: string[] }).steps[0]).toBe(
      'Click in "Form – Browser" (near 10, 20).',
    );
    expect((await runAsTenant(actor, () => teach.review(actor, recording.id))).values).toEqual([]);
  });
});
