// The cross-tenant isolation world: real accounts signed up through the app, a personal Space P and
// a shared Space S of A, each holding one of every kind of thing a person keeps, every one carrying
// a canary string. Callers that must never see P or S read and write through the real HTTP surface;
// a response that carries a canary, or a row of P or S that changed, is a leak.
import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EmailEmulator } from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { LabFeatureSchema } from "@rakazo/contracts";
import { callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessageInTransaction } from "@rakazo/db";
import { vi } from "vitest";
import type { BotIntroHarness } from "./discard-bot-intro.js";
import { discardBotIntroFromCreate } from "./discard-bot-intro.js";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

export type IsolationApp = {
  request: (input: string, init?: RequestInit) => Response | Promise<Response>;
};
export type IsolationHandles = Awaited<ReturnType<typeof createApp>>;

/** The web app's origin, which the API trusts. */
export const ORIGIN = "http://127.0.0.1:5173";
const PASSWORD = "password12";
/** How long a streamed answer is read before the caller hangs up. */
export const STREAM_READ_MS = 1_200;

export interface Person {
  label: string;
  email: string;
  cookie: string;
  userId: string;
  /** The Space and organization the person's own sign-up made. */
  spaceId: string;
  organizationId: string;
}

/** The ids a request may name, by the kind of thing they name. */
export type PoolKey =
  | "botId"
  | "secondBotId"
  | "threadId"
  | "chatId"
  | "groupId"
  | "messageId"
  | "chatMessageId"
  | "runId"
  | "routineId"
  | "taughtSkillId"
  | "draftSkillId"
  | "agentSkillId"
  | "documentId"
  | "pageId"
  | "artifactId"
  | "artifactFamilyId"
  | "boardId"
  | "ticketId"
  | "sectionId"
  | "itemId"
  | "tokenId"
  | "agentSecretId"
  | "secretName"
  | "spaceId"
  | "organizationId"
  | "ownerUserId"
  | "memberUserId"
  // Seeded only in the extended world (`buildIsolationWorld(url, { extended: true })`).
  | "callId"
  | "declineCallId"
  | "incomingCallId"
  | "credentialId"
  | "loginId"
  | "versionId"
  | "computerId"
  | "computerUpdateId"
  | "leaseId"
  | "capabilityId"
  | "mcpServerId"
  | "mcpSessionId"
  | "connectionId"
  | "messagingInstallationId"
  | "identityId"
  | "membershipId"
  | "messagingConnectionId"
  | "approvalRuleId"
  | "commandRuleId"
  | "externalConversationId"
  | "soloOrganizationId"
  | "removableDocumentId"
  | "waitBotId"
  | "waitingRunId"
  | "waitingMessageId"
  | "attachmentArtifactId"
  | "filePath";

export interface Target {
  label: "P" | "S" | "B";
  spaceId: string;
  organizationId: string;
  ids: Partial<Record<PoolKey, string>>;
  /** Every canary planted in this Space; one in a foreign caller's answer is a leak. */
  canaries: string[];
  /** What could not be made through the public API, and how it was made instead. */
  notes: string[];
  /** The kind of thing each canary names (`bot`, `vault`, `token`, ...), by canary. */
  kinds?: Record<string, string>;
  /** The owner's own email address and display name: no foreigner may see them either. */
  identityCanaries?: string[];
}

/** What the app sent out while the world ran: jobs, push notifications and mail, in order. */
export interface IsolationRecords {
  jobs: string[];
  notifications: { userId: string; text: string }[];
  mail: { to: string; text: string }[];
}

export interface IsolationWorld {
  handles: IsolationHandles;
  app: IsolationApp;
  db: PrismaClient;
  A: Person;
  B: Person;
  /** A's organization member, not a member of P, member of S. */
  C: Person;
  /** A guest: invited to S only, not a member of A's organization. */
  D: Person;
  /** Was a member of S, removed by A through the real removal path. */
  E: Person;
  P: Target;
  S: Target;
  /** B's own full set, so B's calls reach real code with valid ids of its own. */
  Bown: Target;
  /** Set in the extended world only. */
  records?: IsolationRecords;
  stop(): Promise<void>;
}

/**
 * Letters only: a name of mixed case with digits reads as an opaque token, and the product
 * shows such a bot or group name blank, which would hide the canary from the scan.
 */
const rand = () =>
  Array.from(randomBytes(10), (byte) => String.fromCharCode(97 + (byte % 26))).join("");

export function canary(prefix: string, kind: string) {
  return `ISO-${prefix}-${kind}-${rand()}`;
}

/**
 * The canary as it reads inside base64 at each of the three byte alignments (file contents travel
 * as `contentBase64`), minus the edge characters that depend on the bytes around it.
 */
function base64Forms(value: string): string[] {
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.from(`${"x".repeat(offset)}${value}`).toString("base64");
    return encoded.slice(Math.ceil(offset / 3) * 4, Math.floor((offset + value.length) / 3) * 4);
  });
}

/** Every canary of `canaries` that `text` contains, as written or base64-encoded. */
export function findCanaries(text: string, canaries: readonly string[]): string[] {
  return canaries.filter(
    (value) => text.includes(value) || base64Forms(value).some((form) => text.includes(form)),
  );
}

/**
 * The app on `databaseUrl`: the runtime login (row-level security on) by default, or the table
 * owner's, which bypasses it, so only the app's own filters keep tenants apart.
 */
export async function startIsolationApp(
  databaseUrl = process.env.DATABASE_URL!,
  /** More of `createApp`'s overrides, such as a mail provider. */
  overrides: Omit<NonNullable<Parameters<typeof createApp>[0]>, "databaseUrl"> = {},
): Promise<{
  handles: IsolationHandles;
  cleanup(): Promise<void>;
}> {
  process.env.WAKEUP_DRIVER = "memory";
  process.env.SANDBOX_PROVIDER = "fake";
  process.env.AGENT_RUNTIME = "scripted";
  const dataDir = mkdtempSync(path.join(tmpdir(), "dozo-isolation-"));
  const { createApp } = await import("@rakazo/api/app");
  const handles = await createApp({
    databaseUrl,
    encryptionKey: "offline-isolation-encryption-key",
    dataDir,
    sandboxProvider: "fake",
    agentRuntime: "scripted",
    wakeupDriver: "memory",
    signupsEnabled: "true",
    ...overrides,
  });
  return {
    handles,
    async cleanup() {
      await handles.stop();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

export async function signup(app: IsolationApp, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD, name }),
  });
  if (response.status >= 400) {
    throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

/**
 * The session confirms it is the person, as clients do before a guarded procedure (tokens, vault
 * reveal). Foreign callers confirm too, so their calls reach the code behind the guard.
 */
export async function confirmIdentity(app: IsolationApp, cookie: string) {
  const response = await app.request("/api/auth/confirm-identity", {
    method: "POST",
    headers: { "content-type": "application/json", cookie, origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  if (response.status >= 400) {
    throw new Error(`confirm-identity failed ${response.status}: ${await response.text()}`);
  }
}

/** One real `/rpc/<path>` request; no cookie means anonymous, no Space means the session's own. */
export function rawRpc(
  app: IsolationApp,
  cookie: string | undefined,
  procedure: string,
  body: unknown,
  spaceId?: string,
  signal?: AbortSignal,
) {
  return app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
      ...(spaceId ? { "x-rakazo-space-id": spaceId } : {}),
      origin: ORIGIN,
    },
    body: JSON.stringify(body === undefined ? {} : { json: body }),
    ...(signal ? { signal } : {}),
  });
}

/**
 * The whole answer as text. A streamed answer (event iterator) is read for `streamMs` and then
 * the caller hangs up, as a client would; whatever arrived until then is the answer.
 */
export async function readAnswer(
  app: IsolationApp,
  cookie: string | undefined,
  procedure: string,
  body: unknown,
  spaceId?: string,
  streamMs = STREAM_READ_MS,
): Promise<{ status: number; text: string; streamed: boolean; headers: string }> {
  const controller = new AbortController();
  const response = await rawRpc(app, cookie, procedure, body, spaceId, controller.signal);
  const streamed = (response.headers.get("content-type") ?? "").includes("text/event-stream");
  const headers = [...response.headers].map(([name, value]) => `${name}: ${value}`).join("\n");
  if (!streamed || !response.body)
    return { status: response.status, text: await response.text(), streamed, headers };
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  // Hanging up ends the pending read with `done`, as a client closing the stream would.
  const hangUp = AbortSignal.timeout(streamMs);
  hangUp.addEventListener("abort", () => void reader.cancel(), { once: true });
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  controller.abort();
  return { status: response.status, text, streamed, headers };
}

export async function rpc<T>(
  world: { app: IsolationApp; handles?: BotIntroHarness },
  cookie: string,
  procedure: string,
  body: unknown = {},
  spaceId?: string,
): Promise<T> {
  const response = await rawRpc(world.app, cookie, procedure, body, spaceId);
  const text = await response.text();
  const payload = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (response.status >= 400 || payload.error) {
    throw new Error(`${procedure} ${response.status}: ${payload.error?.message ?? text}`);
  }
  return discardBotIntroFromCreate(world.handles, cookie, procedure, payload.json as T);
}

/**
 * With mail on, a sign-up leaves an unverified account and no session: the address is marked
 * verified through the system client, as its emailed link would, and the person signs in.
 */
async function signupVerified(app: IsolationApp, db: PrismaClient, email: string, name: string) {
  const cookie = await signup(app, email, name);
  if (cookie) return cookie;
  await db.user.update({ where: { email }, data: { emailVerified: true } });
  const response = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  if (response.status >= 400) {
    throw new Error(`sign-in failed ${response.status}: ${await response.text()}`);
  }
  return sessionCookieHeader(response);
}

async function person(
  app: IsolationApp,
  db: PrismaClient,
  label: string,
  stamp: string,
  name = `Iso ${label}`,
) {
  const email = `iso-${label.toLowerCase()}-${stamp}@rakazo.test`;
  const cookie = await signupVerified(app, db, email, name);
  await confirmIdentity(app, cookie);
  // Every lab on, so the procedures behind one (the board) answer from real code.
  await rpc({ app }, cookie, "preferences/update", { labs: [...LabFeatureSchema.options] });
  const user = await db.user.findUniqueOrThrow({ where: { email }, select: { id: true } });
  const space = await db.space.findFirstOrThrow({
    where: { createdByUserId: user.id, isDefault: true },
    select: { id: true, organizationId: true },
  });
  return {
    label,
    email,
    cookie,
    userId: user.id,
    spaceId: space.id,
    organizationId: space.organizationId,
  } satisfies Person;
}

const pageSource = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Metrics metrics={[{ value: "42", label: "Users" }]} />\n  </Page>\n);\nexport default App;\n`;

/** Sends as `cookie` and waits until the bot's run for it has ended. */
export async function sendAndWait(
  world: { app: IsolationApp; handles: IsolationHandles },
  cookie: string,
  target: Record<string, string>,
  text: string,
  spaceId: string,
) {
  await rpc(world, cookie, "threads/send", { ...target, text }, spaceId);
  await vi.waitFor(
    async () => {
      const snap = await rpc<{ run?: { status: string } | null }>(
        world,
        cookie,
        "threads/get",
        target,
        spaceId,
      );
      if (snap.run && !["completed", "failed", "cancelled"].includes(snap.run.status))
        throw new Error("the run did not end");
    },
    { timeout: 30_000, interval: 100 },
  );
}

/**
 * One of every kind of thing in `spaceId`, made by `owner` through the public API where one
 * exists, every one named with a canary of `prefix`.
 */
export async function seedTarget(
  world: { app: IsolationApp; handles: IsolationHandles; db: PrismaClient },
  owner: Person,
  spaceId: string,
  label: Target["label"],
  prefix: string,
  memberUserId: string,
  /** Also a file, an attachment and a removable memory document (see `seedExtras`). */
  extended = false,
): Promise<Target> {
  const { db } = world;
  const canaries: string[] = [];
  const notes: string[] = [];
  const kinds: Record<string, string> = {};
  const plant = (value: string, kind: string) => {
    canaries.push(value);
    kinds[value] = kind;
    return value;
  };
  const mark = (kind: string) => plant(canary(prefix, kind), kind);
  const call = <T>(procedure: string, body: unknown) =>
    rpc<T>(world, owner.cookie, procedure, body, spaceId);
  const space = await db.space.findUniqueOrThrow({
    where: { id: spaceId },
    select: { organizationId: true },
  });
  const ids: Target["ids"] = {
    spaceId,
    organizationId: space.organizationId,
    ownerUserId: owner.userId,
    memberUserId,
  };

  const bot = await call<{ id: string }>("bots/create", {
    name: mark("bot").slice(0, 40),
    title: "",
    description: mark("botdescription"),
    instructions: mark("instructions"),
    notifyOnFinish: false,
  });
  ids.botId = bot.id;
  const thread = await db.thread.findUniqueOrThrow({ where: { botId: bot.id } });
  ids.threadId = thread.id;
  const main = { botId: bot.id };

  // Plain text, then a memory note and a page through the scripted runtime's real tools: the page
  // leaves a tool step block (save_page) and its output in the chat.
  await sendAndWait(world, owner.cookie, main, `${mark("message")} hello`, spaceId);
  await sendAndWait(world, owner.cookie, main, `remember ${mark("memory")}`, spaceId);
  const pageTitle = mark("page");
  await sendAndWait(
    world,
    owner.cookie,
    main,
    `call save_page with ${JSON.stringify({ title: pageTitle, source: pageSource(mark("pagebody")) })}`,
    spaceId,
  );
  const firstMessage = await db.message.findFirstOrThrow({
    where: { threadId: thread.id, role: "user" },
    orderBy: { seq: "asc" },
  });
  ids.messageId = firstMessage.id;
  const lastRun = await db.run.findFirst({
    where: { botId: bot.id },
    orderBy: { createdAt: "desc" },
  });
  if (lastRun) ids.runId = lastRun.id;
  const memory = await db.memoryDocument.findFirst({ where: { spaceId, botId: bot.id } });
  if (memory) ids.documentId = memory.id;
  else notes.push("memory: the scripted 'remember' turn left no memory document");
  const page = await db.page.findFirst({ where: { spaceId, botId: bot.id } });
  if (page) ids.pageId = page.id;
  else notes.push("page: the scripted save_page turn left no page");

  // Extended world: what only a turn of the bot or a send can leave, before teaching blocks sends.
  const sendStep = async (name: string, work: () => Promise<void>) => {
    if (!extended) return;
    try {
      await work();
    } catch (error) {
      notes.push(`${name}: could not be seeded (${String(error).slice(0, 200)})`);
    }
  };
  // A file in the bot's home, written by the bot's own tool, and an attachment sent the way the
  // composer sends one: uploaded first, then named by the message.
  await sendStep("computer file", async () => {
    const filePath = `notes/iso-${rand()}.txt`;
    await sendAndWait(
      world,
      owner.cookie,
      main,
      `write a file called ${filePath} that says ${mark("file")}`,
      spaceId,
    );
    ids.filePath = filePath;
  });
  await sendStep("attachment", async () => {
    const artifact = await call<{ id: string }>("artifacts/create", {
      botId: bot.id,
      name: `${mark("attachment")}.txt`,
      mimeType: "text/plain",
      contentBase64: Buffer.from(`${mark("attachmentbody")}\n`).toString("base64"),
    });
    ids.attachmentArtifactId = artifact.id;
    await sendAttachedAndWait(
      world,
      owner.cookie,
      { botId: bot.id, text: mark("attachmentmessage"), artifactIds: [artifact.id] },
      spaceId,
    );
  });
  await sendStep("removable memory", async () => {
    const path = `notes/iso-${rand()}.md`;
    await sendAndWait(
      world,
      owner.cookie,
      main,
      `save shared memory named ${path} with: ${mark("sharedmemory")}`,
      spaceId,
    );
    const doc = await db.memoryDocument.findFirstOrThrow({ where: { spaceId, path } });
    ids.removableDocumentId = doc.id;
  });
  const chat = await call<{ chat: { id: string } }>("dozoChats/create", {
    botId: bot.id,
    name: mark("chat"),
  });
  ids.chatId = chat.chat.id;
  await sendAndWait(
    world,
    owner.cookie,
    { chatBotId: bot.id, chatId: chat.chat.id },
    `${mark("chatmessage")} in the extra chat`,
    spaceId,
  );
  const chatMessage = await db.message.findFirst({
    where: { threadId: chat.chat.id, role: "user" },
    orderBy: { seq: "asc" },
  });
  if (chatMessage) ids.chatMessageId = chatMessage.id;

  await call("dozoMessages/pin", { threadId: thread.id, messageId: firstMessage.id, pinned: true });

  const routine = await call<{ id: string }>("routines/create", {
    botId: bot.id,
    name: mark("routine").slice(0, 60),
    prompt: mark("routineprompt"),
    crons: ["0 9 * * 1"],
    timezone: "UTC",
    notify: false,
    active: false,
  });
  ids.routineId = routine.id;
  await call("dozoChats/setRoutineChat", { routineId: routine.id, chatId: chat.chat.id });

  // A skill's name is lower case; its canary is kept in that case.
  const skillName = plant(canary(prefix, "skill").toLowerCase(), "skill");
  const agentSkill = await call<{ id: string }>("agentSkills/create", {
    name: skillName,
    description: mark("skilldescription"),
    body: mark("skillbody"),
  });
  ids.agentSkillId = agentSkill.id;
  try {
    // A stopped session leaves a draft, which only editing, saving and test runs take; a second
    // one is still recording (and holds the computer), which the teaching calls take.
    const draft = await call<{ id: string }>("skills/start", {
      botId: bot.id,
      goal: mark("draftskill"),
    });
    await call("skills/stop", { skillId: draft.id });
    ids.draftSkillId = draft.id;
    const taught = await call<{ id: string }>("skills/start", {
      botId: bot.id,
      goal: mark("taught"),
    });
    ids.taughtSkillId = taught.id;
    // The recording lives as long as the control lease it took, which the app's page renews
    // (`computer/heartbeat`). Unrenewed it lapses after COMPUTER_CONTROL_LEASE_MS (90s) and the
    // expiry job drafts the recording, changing the target's rows inside whichever snapshot
    // window is open on a slow run. Hold the lease for the whole run, as a page left open would.
    await db.computer.updateMany({
      where: { bots: { some: { id: bot.id } }, controlLeaseId: { not: null } },
      data: { controlLeaseExpiresAt: new Date(Date.now() + 60 * 60_000) },
    });
  } catch (error) {
    notes.push(`taught skill: skills/start refused (${String(error).slice(0, 120)})`);
  }

  // A secret's name is lower case by contract; its canary keeps the ISO prefix in that case. That
  // one is never sent by a foreign caller. A second item's name is what foreign calls look up by
  // name, so it is no canary: a caller's own words echoed back (an audit line naming what it
  // tried to remove) are not a leak.
  const secretName = plant(`iso-${prefix.toLowerCase()}-secret-${rand()}`, "secret");
  const lookupName = `lookup-${prefix.toLowerCase()}-${rand()}`;
  ids.secretName = lookupName;
  // No scope: the vault this Space uses (a personal Space uses the account's).
  for (const name of [secretName, lookupName]) {
    await call("vault/put", {
      destination: { name, auth: { type: "command" } },
      value: "placeholder-not-a-secret",
      title: mark("vault"),
    });
  }
  const agentSecretName = plant(`ISO_${prefix}_AGENTSECRET_${rand().toUpperCase()}`, "agentsecret");
  const agentSecret = await call<{ id: string }>("agentSecrets/put", {
    name: agentSecretName,
    value: "placeholder-not-a-secret",
  });
  ids.agentSecretId = agentSecret.id;

  const token = await call<{ accessToken: { id: string } }>("dozoAccessTokens/create", {
    name: mark("token").slice(0, 60),
    botId: bot.id,
  });
  ids.tokenId = token.accessToken.id;

  const second = await call<{ id: string }>("bots/create", {
    name: mark("secondbot").slice(0, 40),
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  ids.secondBotId = second.id;
  const group = await call<{ id: string }>("groups/create", {
    name: mark("group").slice(0, 40),
    botIds: [bot.id, second.id],
  });
  ids.groupId = group.id;
  const section = await call<{ id: string }>("botSections/create", {
    botId: bot.id,
    name: mark("section").slice(0, 40),
  });
  ids.sectionId = section.id;
  const item = await call<{ id: string }>("scratchpad/create", {
    botId: bot.id,
    title: mark("scratchpad"),
  });
  ids.itemId = item.id;
  const artifactName = `${mark("artifact")}.txt`;
  const artifact = await call<{ id: string; familyId?: string }>("artifacts/create", {
    botId: bot.id,
    name: artifactName,
    mimeType: "text/plain",
    contentBase64: Buffer.from(`${mark("artifactbody")}\n`).toString("base64"),
  });
  ids.artifactId = artifact.id;
  const stored = await db.artifact.findUniqueOrThrow({ where: { id: artifact.id } });
  // The first version's own id is its family's id.
  ids.artifactFamilyId = artifact.familyId ?? stored.rootArtifactId ?? artifact.id;
  const board = await call<{ id: string }>("boards/get", {});
  ids.boardId = board.id;
  const ticket = await call<{ id: string }>("tickets/create", {
    boardId: board.id,
    title: mark("ticket"),
    assigneeBotId: bot.id,
  });
  ids.ticketId = ticket.id;

  // No public procedure records usage, audit entries or a waiting run on demand: system inserts.
  const system = asSystem(db);
  await system.usageRecord.create({
    data: { spaceId, botId: bot.id, userId: owner.userId, provider: "fake", model: mark("usage") },
  });
  notes.push("usage record: inserted through the system client (no API writes usage)");
  await system.auditEvent.create({
    data: {
      organizationId: space.organizationId,
      spaceId,
      actorType: "user",
      actorId: owner.userId,
      action: "bot.update",
      targetType: "bot",
      targetId: bot.id,
      targetLabel: mark("audit"),
      outcome: "success",
    },
  });
  notes.push(
    "audit record: inserted through the system client (audit rows are written by other actions)",
  );
  const task = await system.task.create({
    data: {
      spaceId,
      botId: bot.id,
      threadId: thread.id,
      userId: owner.userId,
      prompt: mark("queued"),
      status: "queued",
    },
  });
  const queued = await system.run.create({
    data: {
      spaceId,
      botId: bot.id,
      threadId: thread.id,
      taskId: task.id,
      userId: owner.userId,
      status: "queued",
      trigger: "routine",
      routineId: routine.id,
    },
  });
  ids.runId = queued.id;
  notes.push(
    "queue item: a queued run inserted through the system client (a real one needs a run held open for the whole sweep)",
  );

  return { label, spaceId, organizationId: space.organizationId, ids, canaries, notes, kinds };
}

/** Sends with attachments and waits until the bot's run for it has ended. */
async function sendAttachedAndWait(
  world: { app: IsolationApp; handles: IsolationHandles },
  cookie: string,
  input: { botId: string; text: string; artifactIds: string[] },
  spaceId: string,
) {
  await rpc(world, cookie, "threads/send", input, spaceId);
  await sendAndWait(world, cookie, { botId: input.botId }, "and that is all", spaceId);
}

/**
 * The rest of what a person keeps, for the matrix's extended world: things that come from outside
 * providers (a call, a messaging app, a tool server, a model connection) are inserted through the
 * system client in the shape the provider's adapter writes; the rest go through the public API.
 * Each one carries a canary and lands in `target.ids`. A seed that fails is noted, never thrown:
 * the matrix then fails on the id it could not fill.
 */
export async function seedExtras(
  world: { app: IsolationApp; handles: IsolationHandles; db: PrismaClient },
  owner: Person,
  target: Target,
  prefix: string,
  soloOrganizationId: string,
) {
  const { db } = world;
  const { ids, spaceId } = target;
  target.kinds ??= {};
  const kinds = target.kinds;
  const mark = (kind: string) => {
    const value = canary(prefix, kind);
    target.canaries.push(value);
    kinds[value] = kind;
    return value;
  };
  const call = <T>(procedure: string, body: unknown) =>
    rpc<T>(world, owner.cookie, procedure, body, spaceId);
  const step = async (name: string, work: () => Promise<void>) => {
    try {
      await work();
    } catch (error) {
      target.notes.push(`${name}: could not be seeded (${String(error).slice(0, 200)})`);
    }
  };
  const botId = ids.botId!;
  const secondBotId = ids.secondBotId!;
  const threadId = ids.threadId!;
  ids.soloOrganizationId = soloOrganizationId;

  await step("instruction version", async () => {
    await call("bots/update", { botId, instructions: mark("instructionsnext") });
    const bot = await db.bot.findUniqueOrThrow({ where: { id: botId } });
    const history = bot.instructionHistory as { id?: string }[] | null;
    if (!history?.[0]?.id) throw new Error("no instruction history");
    ids.versionId = history[0].id;
  });
  await step("approval rule", async () => {
    const rule = await call<{ id: string }>("approvalRules/set", {
      effect: "require_approval",
      matchKind: "tool",
      matchValue: mark("approvalrule"),
    });
    ids.approvalRuleId = rule.id;
  });

  const system = asSystem(db);
  // Three ringing calls from the bot: one to answer and end, one to decline in the chat, one to
  // decline from a locked phone. Rung far ahead, so none rings out during the sweep.
  for (const key of ["callId", "declineCallId", "incomingCallId"] as const) {
    await step(key, async () => {
      const callId = randomUUID();
      const blocks = [
        {
          kind: "call_request" as const,
          callId,
          reason: mark("callreason"),
          opening: mark("callopening"),
          status: "ringing" as const,
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
        },
      ];
      await system.$transaction((tx) =>
        createThreadMessageInTransaction(tx, {
          threadId,
          botId,
          role: "bot",
          blocks,
          clientNonce: callRequestClientNonce(callId),
          markUnread: true,
        }),
      );
      ids[key] = callId;
    });
  }
  notes(target, "calls: ringing call cards inserted through the system client (no voice provider)");

  await step("waiting work", async () => {
    // On a bot of its own, in no group and named by no other seed, so nothing else wakes it.
    const waiter = await call<{ id: string }>("bots/create", {
      name: mark("waitbot").slice(0, 40),
      title: "",
      description: "",
      instructions: "",
      notifyOnFinish: false,
    });
    ids.waitBotId = waiter.id;
    await seedHeldMessage(db, owner, target);
    // Until a test seeds a fresh one, the queued run the base seed left names a waiting run.
    ids.waitingRunId = ids.runId;
  });
  notes(target, "waiting work: a held message on a bot no one talks to, system insert");

  await step("model connection", async () => {
    const secret = await system.secret.create({
      data: { userId: owner.userId, kind: "model", ciphertext: "placeholder-not-a-secret" },
    });
    const credential = await system.userModelCredential.create({
      data: {
        userId: owner.userId,
        provider: "openai-compatible",
        label: mark("credential"),
        secretId: secret.id,
      },
    });
    ids.credentialId = credential.id;
    const login = await system.modelOAuthSession.create({
      data: {
        id: `iso-login-${rand()}`,
        spaceId,
        userId: owner.userId,
        provider: "openai-compatible",
        scope: "user",
      },
    });
    ids.loginId = login.id;
  });
  await step("computer", async () => {
    const bot = await system.bot.findUniqueOrThrow({
      where: { id: botId },
      select: { computer: { select: { id: true, controlLeaseId: true } } },
    });
    if (!bot.computer) throw new Error("the bot has no computer");
    ids.computerId = bot.computer.id;
    if (bot.computer.controlLeaseId) ids.leaseId = bot.computer.controlLeaseId;
    const update = await system.computerUpdate.create({
      data: { computerId: bot.computer.id, botId, status: "failed" },
    });
    ids.computerUpdateId = update.id;
  });
  await step("capability", async () => {
    const install = await system.capabilityInstall.create({
      data: {
        spaceId,
        userId: owner.userId,
        kind: "plugin",
        name: mark("capability"),
        source: "https://example.test/plugin",
      },
    });
    ids.capabilityId = install.id;
  });
  await step("tool server", async () => {
    const server = await system.mcpServer.create({
      data: {
        spaceId,
        userId: owner.userId,
        slug: `iso-${rand()}`,
        name: mark("mcpserver"),
        transport: "streamable_http",
        endpoint: "https://example.test/mcp",
      },
    });
    ids.mcpServerId = server.id;
    const session = await system.mcpOAuthSession.create({
      data: {
        id: `iso-mcp-${rand()}`,
        spaceId,
        userId: owner.userId,
        serverId: server.id,
        endpoint: "https://example.test/mcp",
        redirectUri: "https://example.test/callback",
        oauthCiphertext: "placeholder-not-a-secret",
      },
    });
    ids.mcpSessionId = session.id;
  });
  await step("connection", async () => {
    const connection = await system.connection.create({
      data: {
        spaceId,
        userId: owner.userId,
        provider: "iso",
        displayName: mark("connection"),
        status: "connected",
      },
    });
    ids.connectionId = connection.id;
  });
  await step("messaging", async () => {
    const identity = await system.messagingIdentity.create({
      data: {
        provider: "iso",
        address: mark("messagingaddress"),
        userId: owner.userId,
        spaceId,
        botId,
      },
    });
    ids.identityId = identity.id;
    const installation = await system.messagingInstallation.create({
      data: {
        provider: "iso",
        workspaceId: `iso-${rand()}`,
        // The names below are not canaries: no read of the owner's shows them for a provider the
        // tests do not run. The rows' ids are in the id scan instead.
        workspaceName: "iso workspace",
        spaceId,
        userId: owner.userId,
        botId,
        ciphertext: "placeholder-not-a-secret",
      },
    });
    ids.messagingInstallationId = installation.id;
    const channel = await system.messagingChannel.create({
      data: { provider: "iso", threadId: ids.chatId! },
    });
    const member = await system.messagingChannelMember.create({
      data: {
        channelId: channel.id,
        address: "iso-channel-member",
        status: "invited",
        identityId: identity.id,
      },
    });
    ids.membershipId = member.id;
    const connection = await system.agentConnection.create({
      data: { requesterBotId: secondBotId, targetBotId: botId, status: "pending" },
    });
    ids.messagingConnectionId = connection.id;
    const conversation = await system.externalConversation.create({
      data: {
        provider: "iso",
        workspaceId: "iso",
        externalKey: `iso-${rand()}`,
        conversationId: `iso-${rand()}`,
        participantNames: ["iso participant"],
        spaceId,
        botId,
        userId: owner.userId,
      },
    });
    ids.externalConversationId = conversation.id;
  });
  notes(
    target,
    "messaging, tool server, model connection, connection, capability, computer update: system inserts (each needs an outside provider)",
  );
  await step("command rule", async () => {
    const id = randomUUID();
    await system.$executeRaw`
      INSERT INTO dozo_command_policies (id, "userId", "spaceId", "botId", computer, words, cwd)
      VALUES (${id}, ${owner.userId}, ${spaceId}, ${botId}, 'hosted', ${[mark("commandrule")]}, '/')`;
    ids.commandRuleId = id;
  });
}

/**
 * A run queued on the target's second bot, made fresh: the app's own reconciler starts waiting work
 * within half a minute, so a test that names one seeds it right before and cancels it right after.
 */
export async function seedWaitingRun(db: PrismaClient, owner: Person, target: Target) {
  const system = asSystem(db);
  const { spaceId, ids } = target;
  const botId = ids.secondBotId!;
  const thread = await system.thread.findUniqueOrThrow({ where: { botId } });
  const task = await system.task.create({
    data: {
      spaceId,
      botId,
      threadId: thread.id,
      userId: owner.userId,
      prompt: "iso waiting task",
      status: "queued",
    },
  });
  const run = await system.run.create({
    data: {
      spaceId,
      botId,
      threadId: thread.id,
      taskId: task.id,
      userId: owner.userId,
      status: "queued",
      trigger: "user",
    },
  });
  ids.waitingRunId = run.id;
  return run.id;
}

/**
 * A message held for the target's waiting bot: no run of that bot ever starts, so it stays held.
 * Not a canary: no read of the owner's shows a held message; it is a message like the chat's,
 * whose canary every message read is scanned for.
 */
async function seedHeldMessage(db: PrismaClient, owner: Person, target: Target) {
  const system = asSystem(db);
  const botId = target.ids.waitBotId!;
  const thread = await system.thread.findUniqueOrThrow({ where: { botId } });
  const message = await system.$transaction((tx) =>
    createThreadMessageInTransaction(tx, {
      threadId: thread.id,
      role: "user",
      authorUserId: owner.userId,
      blocks: [{ kind: "text", text: "iso waiting message" }],
    }),
  );
  await system.steeringMessage.create({
    data: { messageId: message.id, botId, userId: owner.userId },
  });
  target.ids.waitingMessageId = message.id;
}

function notes(target: Target, line: string) {
  if (!target.notes.includes(line)) target.notes.push(line);
}

export async function joinWithInvite(
  world: { app: IsolationApp; handles: IsolationHandles },
  owner: Person,
  guest: Person,
  spaceId: string,
) {
  const link = await rpc<{ url: string }>(world, owner.cookie, "spaces/invites/create", {
    spaceId,
  });
  const token = new URL(link.url).pathname.split("/").pop() ?? "";
  await rpc(world, guest.cookie, "spaces/invites/accept", { token });
}

/** Set while the app answers a request of the world's, and in all work that request starts. */
const inRequest = new AsyncLocalStorage<true>();

/**
 * Every job, push notification and mail the app sends from now on while answering a request (or
 * in work a request started), recorded as text so a scan can tell whom and what each one names.
 * The app's own timers (its reconciler re-enqueues expiry jobs for ringing calls) are not a
 * request's doing and are left out.
 */
function recordOutgoing(handles: IsolationHandles): IsolationRecords {
  const records: IsolationRecords = { jobs: [], notifications: [], mail: [] };
  const text = (args: unknown[]) =>
    JSON.stringify(args, (_key, value: unknown) =>
      typeof value === "bigint" ? String(value) : value,
    );
  const jobs = handles.jobs as unknown as Record<string, unknown>;
  for (const name of new Set([
    ...Object.keys(jobs),
    ...Object.getOwnPropertyNames(Object.getPrototypeOf(jobs) ?? {}),
  ])) {
    if (name === "constructor" || typeof jobs[name] !== "function") continue;
    if (!/^(enqueue|publish|add|wake|schedule)/i.test(name)) continue;
    const original = (jobs[name] as (...args: unknown[]) => unknown).bind(jobs);
    jobs[name] = (...args: unknown[]) => {
      if (inRequest.getStore()) records.jobs.push(`${name} ${text(args)}`);
      return original(...args);
    };
  }
  const notifications = handles.notifications as unknown as Record<
    string,
    ((...args: unknown[]) => unknown) | undefined
  >;
  for (const name of ["send", "incomingCall"]) {
    const original = notifications[name]?.bind(notifications);
    if (!original) continue;
    notifications[name] = (...args: unknown[]) => {
      const first = args[0] as { userId?: string } | string | undefined;
      const userId = typeof first === "string" ? first : (first?.userId ?? "");
      if (inRequest.getStore()) records.notifications.push({ userId, text: text(args) });
      return original(...args);
    };
  }
  const mail = handles.email as unknown as
    | { send(message: { to?: unknown }): Promise<void> }
    | undefined;
  if (mail) {
    const original = mail.send.bind(mail);
    mail.send = (message) => {
      if (inRequest.getStore())
        records.mail.push({ to: String(message.to ?? ""), text: text([message]) });
      return original(message);
    };
  }
  return records;
}

/**
 * `extended`: the matrix's world. Mail goes to an emulator and calls are on, every procedure's
 * id has something real to name (`seedExtras`), the owner's name and address are canaries, and
 * outgoing jobs, notifications and mail are recorded. The default world stays as it was.
 */
export async function buildIsolationWorld(
  databaseUrl?: string,
  options: { extended?: boolean } = {},
): Promise<IsolationWorld> {
  const extended = options.extended === true;
  const { handles, cleanup } = await startIsolationApp(
    databaseUrl,
    extended
      ? {
          email: new EmailEmulator(),
          phoneCallsEnabled: true,
          phoneCallRingSeconds: 24 * 60 * 60,
        }
      : {},
  );
  const app: IsolationApp = extended
    ? { request: (input, init) => inRequest.run(true, () => handles.app.request(input, init)) }
    : handles.app;
  const db = asSystem(handles.prisma);
  const world = { app, handles, db };
  const stamp = `${Date.now()}-${rand()}`;
  const ownerName = extended ? canary("A", "ownername") : undefined;
  const A = await person(app, db, "A", stamp, ownerName);
  const B = await person(app, db, "B", stamp);
  const C = await person(app, db, "C", stamp);
  const D = await person(app, db, "D", stamp);
  const E = await person(app, db, "E", stamp);

  const shared = await rpc<{ id: string }>(world, A.cookie, "spaces/create", {
    name: "Iso shared",
  });
  // C joins A's organization the way the directory adds a member; the organization's trigger puts
  // a new member into its default Space, so A removes C from P through the real removal path.
  await db.member.create({
    data: {
      id: `iso-member-${stamp}`,
      organizationId: A.organizationId,
      userId: C.userId,
      role: "member",
      createdAt: new Date(),
    },
  });
  if (await db.spaceMember.findFirst({ where: { spaceId: A.spaceId, userId: C.userId } })) {
    await rpc(world, A.cookie, "spaces/members/remove", { spaceId: A.spaceId, userId: C.userId });
  }
  await joinWithInvite(world, A, C, shared.id);
  await joinWithInvite(world, A, D, shared.id);
  await joinWithInvite(world, A, E, shared.id);
  await rpc(world, A.cookie, "spaces/members/remove", { spaceId: shared.id, userId: E.userId });

  const P = await seedTarget(world, A, A.spaceId, "P", "A", A.userId, extended);
  const S = await seedTarget(world, A, shared.id, "S", "S", D.userId, extended);
  const Bown = await seedTarget(world, B, B.spaceId, "B", "B", B.userId, extended);
  if (!extended) return { handles, app, db, A, B, C, D, E, P, S, Bown, stop: cleanup };
  const solo = await rpc<{ id: string }>(world, A.cookie, "organizations/create", {
    name: canary("A", "soloorg").slice(0, 60),
  });
  await seedExtras(world, A, P, "A", solo.id);
  await seedExtras(world, A, S, "S", solo.id);
  const soloB = await rpc<{ id: string }>(world, B.cookie, "organizations/create", {
    name: canary("B", "soloorg").slice(0, 60),
  });
  await seedExtras(world, B, Bown, "B", soloB.id);
  for (const target of [P, S]) target.identityCanaries = [A.email, ownerName!];
  return {
    handles,
    app,
    db,
    A,
    B,
    C,
    D,
    E,
    P,
    S,
    Bown,
    records: recordOutgoing(handles),
    stop: cleanup,
  };
}

// ---------------------------------------------------------------------------------------------
// Snapshot of everything P and S hold, read through the system client.

type ModelInfo = { delegate: string; fields: Set<string> };

let models: ModelInfo[] | undefined;

/** Every model of the schema with its scalar field names, read from the schema file itself. */
function schemaModels(): ModelInfo[] {
  if (models) return models;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const schema = readFileSync(path.resolve(here, "../../db/prisma/schema.prisma"), "utf8");
  models = [];
  for (const block of schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)) {
    const fields = new Set<string>();
    for (const line of block[2]!.split("\n")) {
      const field = /^\s+(\w+)\s+(\w+)(\[\])?(\?)?/.exec(line);
      if (field && !line.trim().startsWith("//") && !line.trim().startsWith("@@"))
        fields.add(field[1]!);
    }
    const name = block[1]!;
    models.push({ delegate: name.charAt(0).toLowerCase() + name.slice(1), fields });
  }
  return models;
}

export type Snapshot = Map<string, Map<string, string>>;

function stable(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item === "bigint") return `${item}n`;
    if (item instanceof Uint8Array) return Buffer.from(item).toString("hex");
    if (item && typeof item === "object" && !Array.isArray(item) && !(item instanceof Date)) {
      return Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)));
    }
    return item;
  });
}

/**
 * Every row any table holds for the given Spaces: rows keyed by the Space, its organization, its
 * owner, or one of its bots or chats. Rows are compared whole, so an update shows as a change.
 */
export async function snapshot(
  db: PrismaClient,
  scope: { spaceIds: string[]; organizationIds: string[]; userIds: string[] },
): Promise<Snapshot> {
  const bots = (
    await db.bot.findMany({ where: { spaceId: { in: scope.spaceIds } }, select: { id: true } })
  ).map((bot) => bot.id);
  const threads = (
    await db.thread.findMany({ where: { spaceId: { in: scope.spaceIds } }, select: { id: true } })
  ).map((thread) => thread.id);
  const keys: Record<string, string[]> = {
    spaceId: scope.spaceIds,
    organizationId: scope.organizationIds,
    userId: scope.userIds,
    botId: bots,
    threadId: threads,
  };
  const result: Snapshot = new Map();
  const client = db as unknown as Record<string, { findMany(args: unknown): Promise<unknown[]> }>;
  for (const model of schemaModels()) {
    const or: Record<string, unknown>[] = [];
    // A row that names its Space belongs where that Space is; the rest by owner, bot or chat.
    const fields = model.fields.has("spaceId") ? ["spaceId"] : Object.keys(keys);
    for (const field of fields) {
      const values = keys[field] ?? [];
      if (model.fields.has(field) && values.length) or.push({ [field]: { in: values } });
    }
    if (model.delegate === "space") or.push({ id: { in: scope.spaceIds } });
    if (model.delegate === "organization") or.push({ id: { in: scope.organizationIds } });
    if (model.delegate === "user") or.push({ id: { in: scope.userIds } });
    if (!or.length || !client[model.delegate]) continue;
    const rows = (await client[model.delegate]!.findMany({ where: { OR: or } })) as Record<
      string,
      unknown
    >[];
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const text = stable(row);
      byKey.set(typeof row.id === "string" ? row.id : text, text);
    }
    result.set(model.delegate, byKey);
  }
  await rawTables(db, keys, result);
  return result;
}

let mappedTables: Set<string> | undefined;

/**
 * Tables the fork makes with plain SQL, which the schema file does not list (access tokens,
 * command rules, pins, ...): their rows by the same keys, read through information_schema. Also
 * the job queue's own table when the database has one, by any job whose payload names a key.
 */
async function rawTables(db: PrismaClient, keys: Record<string, string[]>, result: Snapshot) {
  if (!mappedTables) {
    const here = path.dirname(fileURLToPath(import.meta.url));
    const schema = readFileSync(path.resolve(here, "../../db/prisma/schema.prisma"), "utf8");
    mappedTables = new Set(
      [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)].map(
        (block) => /@@map\("([^"]+)"\)/.exec(block[2]!)?.[1] ?? block[1]!,
      ),
    );
  }
  const columns = await db.$queryRaw<{ table_name: string; column_name: string }[]>`
    SELECT table_name, column_name FROM information_schema.columns
    WHERE table_schema = 'public' AND column_name IN ('spaceId', 'userId', 'botId', 'threadId', 'organizationId', 'id')`;
  const byTable = new Map<string, Set<string>>();
  for (const row of columns) {
    if (mappedTables.has(row.table_name) || row.table_name.startsWith("_")) continue;
    const set = byTable.get(row.table_name) ?? new Set<string>();
    set.add(row.column_name);
    byTable.set(row.table_name, set);
  }
  for (const [table, present] of byTable) {
    const fields = present.has("spaceId") ? ["spaceId"] : Object.keys(keys);
    const where: string[] = [];
    const values: string[][] = [];
    for (const field of fields) {
      if (!present.has(field) || !keys[field]?.length) continue;
      values.push(keys[field]!);
      where.push(`"${field}" = ANY($${values.length}::text[])`);
    }
    if (!where.length) continue;
    const rows = await db.$queryRawUnsafe<Record<string, unknown>[]>(
      `SELECT * FROM "${table}" WHERE ${where.join(" OR ")}`,
      ...values,
    );
    const byKey = new Map<string, string>();
    for (const row of rows) {
      const text = stable(row);
      byKey.set(typeof row.id === "string" ? row.id : text, text);
    }
    result.set(`sql:${table}`, byKey);
  }
  const all = Object.values(keys).flat();
  for (const queue of ["graphile_worker._private_jobs", "graphile_worker.jobs"]) {
    const [found] = await db.$queryRawUnsafe<{ name: string | null }[]>(
      "SELECT to_regclass($1)::text AS name",
      queue,
    );
    if (!found?.name) continue;
    const jobs = await db.$queryRawUnsafe<{ id: unknown; text: string }[]>(
      `SELECT id, row_to_json(j)::text AS text FROM ${queue} j`,
    );
    const byKey = new Map<string, string>();
    for (const job of jobs)
      if (all.some((value) => job.text.includes(value))) byKey.set(String(job.id), job.text);
    result.set(`queue:${queue}`, byKey);
    break;
  }
}

/** Each table whose rows differ, with what was added, removed or changed. */
export function snapshotDiff(before: Snapshot, after: Snapshot): string[] {
  const changes: string[] = [];
  for (const [table, rows] of after) {
    const old = before.get(table) ?? new Map<string, string>();
    const added = [...rows.keys()].filter((key) => !old.has(key));
    const removed = [...old.keys()].filter((key) => !rows.has(key));
    const changed = [...rows.keys()].filter(
      (key) => old.has(key) && old.get(key) !== rows.get(key),
    );
    if (added.length || removed.length || changed.length) {
      const sample = changed[0]
        ? ` e.g. ${old.get(changed[0])} -> ${rows.get(changed[0])}`.slice(0, 600)
        : "";
      const addedSample = added[0] ? ` added e.g. ${rows.get(added[0])}`.slice(0, 600) : "";
      changes.push(
        `${table}: +${added.length} -${removed.length} ~${changed.length}${sample}${addedSample}`,
      );
    }
  }
  return changes;
}

/**
 * The app's database login for one pass. The runtime login enforces row-level security; the
 * owner login bypasses it (RLS is enabled, not forced), as an install that connects the app as
 * the table owner does, so that pass proves the app's own filters without the database's.
 */
export const ISOLATION_LOGINS = [
  { name: "runtime login, row-level security on", url: () => process.env.DATABASE_URL! },
  {
    name: "table owner login, no row-level security",
    url: () => {
      const owner = process.env.DATABASE_MIGRATION_URL;
      if (!owner || owner === process.env.DATABASE_URL)
        throw new Error("DATABASE_MIGRATION_URL must name the table owner login");
      return owner;
    },
  },
];
