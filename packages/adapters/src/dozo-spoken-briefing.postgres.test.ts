import { randomUUID } from "node:crypto";
import type { AgentRuntime, AgentRuntimeEvent, ArtifactStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import {
  asSystem,
  createDb,
  createRepos,
  createThreadMessage,
  runAsTenant,
  saveVoicePreference,
  storedMessageBlocks,
  voicePreferenceTarget,
} from "@rakazo/db";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { makeSpokenBriefing, spokenBriefingCoHost } from "./dozo-spoken-briefing.js";
import { SCRIPTED_VOICE_ID } from "./providers/voice/scripted/scripted-voice.js";
import { EncryptedSecretStore } from "./secrets/secrets.js";

// Runs against a migrated database only (dozo/docker/postgres-tests.sh). The fork's unit gate has
// no database and skips it.
const describePostgres =
  process.env.VERIFY_DATABASE && process.env.DATABASE_URL ? describe : describe.skip;

describePostgres("spoken briefings (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  let system: PrismaClient;
  const users: string[] = [];
  const secretStore = new EncryptedSecretStore("test-only-encryption-key");

  beforeAll(() => {
    db = createDb(process.env.DATABASE_URL!);
    prisma = db.prisma;
    system = asSystem(prisma);
  });
  // The test provider speaks only where the scripted runtime runs.
  beforeEach(() => vi.stubEnv("AGENT_RUNTIME", "scripted"));

  afterAll(async () => {
    if (users.length) {
      await system.organization.deleteMany({ where: { id: { in: users } } });
      await system.user.deleteMany({ where: { id: { in: users } } });
    }
    await db?.pool.end();
  });

  async function person(): Promise<Actor> {
    const id = `spoken-briefing-${randomUUID()}`;
    users.push(id);
    const createdAt = new Date();
    await system.user.create({
      data: { id, name: "Ada", email: `${id}@example.test`, emailVerified: true },
    });
    await system.organization.create({ data: { id, name: "Personal", slug: id, createdAt } });
    await system.member.create({
      data: { id: `m-${id}`, organizationId: id, userId: id, role: "owner", createdAt },
    });
    const spaceId = randomUUID();
    await system.space.create({
      data: { id: spaceId, organizationId: id, name: "Home", createdByUserId: id },
    });
    await system.spaceMember.create({
      data: { id: randomUUID(), spaceId, organizationId: id, userId: id, role: "owner", createdAt },
    });
    return { userId: id, spaceId, email: `${id}@example.test`, isDeploymentOwner: false };
  }

  async function voicedBot(actor: Actor, name: string) {
    const bot = await runAsTenant(actor, () =>
      createRepos(prisma).createBot(actor, {
        name,
        description: "",
        instructions: `Speak as ${name}.`,
        notifyOnFinish: false,
      }),
    );
    await system.bot.update({ where: { id: bot.id }, data: { voiceId: SCRIPTED_VOICE_ID } });
    return bot;
  }

  /** The owner's own default voice connection, on the test provider. */
  async function connectVoice(actor: Actor) {
    const context = {
      operationId: "test",
      traceId: "test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const stored = await secretStore.put("scripted-key", context);
    await system.secret.create({
      data: { id: stored.id, userId: actor.userId, kind: "voice", ciphertext: stored.ciphertext },
    });
    const credential = await system.userVoiceCredential.create({
      data: { userId: actor.userId, provider: "scripted", secretId: stored.id },
    });
    await saveVoicePreference(system, await voicePreferenceTarget(system, actor), credential.id, {
      voiceId: SCRIPTED_VOICE_ID,
      isDefault: true,
    });
  }

  /** A routine of the host's whose run completed with a text result in the host's chat. */
  async function completedRoutineRun(actor: Actor, hostId: string, coHostId: string | null) {
    const thread = await system.thread.findFirstOrThrow({ where: { botId: hostId } });
    const routine = await system.routine.create({
      data: {
        spaceId: actor.spaceId,
        botId: hostId,
        userId: actor.userId,
        name: "Orders",
        prompt: "Summarize the orders",
        crons: ["0 8 * * *"],
      },
    });
    if (coHostId)
      await system.$executeRaw`
        INSERT INTO dozo_spoken_briefings ("routineId", "spaceId", "coHostBotId")
        VALUES (${routine.id}, ${actor.spaceId}, ${coHostId})`;
    const task = await system.task.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: hostId,
        threadId: thread.id,
        prompt: routine.prompt,
        status: "completed",
      },
    });
    const run = await system.run.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        botId: hostId,
        threadId: thread.id,
        taskId: task.id,
        routineId: routine.id,
        status: "running",
        trigger: "routine",
      },
    });
    await createThreadMessage(system, {
      threadId: thread.id,
      botId: hostId,
      runId: run.id,
      role: "bot",
      blocks: [{ kind: "text", text: "Three orders shipped. The fourth ships tomorrow." }],
    });
    await system.run.update({ where: { id: run.id }, data: { status: "completed" } });
    return { routineId: routine.id, runId: run.id, threadId: thread.id };
  }

  function deps() {
    const stored = new Map<string, Uint8Array>();
    const artifacts = {
      put: vi.fn(async ({ bytes }: { bytes: Uint8Array }) => {
        const id = randomUUID();
        stored.set(id, bytes);
        return { id, hash: "" };
      }),
      remove: vi.fn(async () => undefined),
    } as unknown as ArtifactStore;
    const runtime = {
      describe: () => ({ capabilities: { compaction: true } }),
      async *run(): AsyncGenerator<AgentRuntimeEvent> {
        yield {
          type: "done",
          text: "A: Three orders shipped.\nB: And the fourth?\nA: Tomorrow.",
        } as AgentRuntimeEvent;
      },
    } as unknown as AgentRuntime;
    return {
      prisma,
      runtime,
      secretStore,
      artifacts,
      events: {
        notify: vi.fn(async () => undefined),
        publishSpaceChange: vi.fn(async () => undefined),
      },
      resolveModel: vi.fn(async () => ({ provider: "test", modelId: "model" })) as never,
    };
  }

  it("posts the briefing once, as an audio message after the result", async () => {
    const actor = await person();
    const host = await voicedBot(actor, "Chef");
    const coHost = await voicedBot(actor, "Nova");
    await connectVoice(actor);
    const { runId, threadId } = await completedRoutineRun(actor, host.id, coHost.id);
    const briefing = deps();
    await runAsTenant(actor, () => makeSpokenBriefing(briefing, runId));
    await runAsTenant(actor, () => makeSpokenBriefing(briefing, runId));
    const messages = await system.message.findMany({
      where: { threadId, role: "bot" },
      orderBy: { seq: "asc" },
      select: { id: true, blocks: true, clientNonce: true, botId: true },
    });
    expect(messages).toHaveLength(2);
    const [, audio] = messages;
    expect(audio?.clientNonce).toBe(`dozo-briefing:${runId}`);
    expect(audio?.botId).toBe(host.id);
    expect(storedMessageBlocks(audio!)).toEqual([
      expect.objectContaining({ kind: "file", mimeType: "audio/mpeg", name: "briefing.mp3" }),
    ]);
    expect(briefing.artifacts.put).toHaveBeenCalledTimes(1);
    expect(briefing.events.notify).toHaveBeenCalledTimes(1);
  });

  it("keeps a Space's co-hosts to that Space, and forgets one whose bot is deleted", async () => {
    const actor = await person();
    const stranger = await person();
    const host = await voicedBot(actor, "Chef");
    const coHost = await voicedBot(actor, "Nova");
    const { routineId } = await completedRoutineRun(actor, host.id, coHost.id);
    expect(await runAsTenant(actor, () => spokenBriefingCoHost(prisma, routineId))).toBe(coHost.id);
    expect(await runAsTenant(stranger, () => spokenBriefingCoHost(prisma, routineId))).toBeNull();
    await system.bot.delete({ where: { id: coHost.id } });
    expect(await spokenBriefingCoHost(system, routineId)).toBeNull();
  });

  it("leaves the result as the only message without the owner's own voice connection", async () => {
    const actor = await person();
    const host = await voicedBot(actor, "Chef");
    const coHost = await voicedBot(actor, "Nova");
    const { runId, threadId } = await completedRoutineRun(actor, host.id, coHost.id);
    await runAsTenant(actor, () => makeSpokenBriefing(deps(), runId));
    expect(await system.message.count({ where: { threadId, role: "bot" } })).toBe(1);
  });
});
