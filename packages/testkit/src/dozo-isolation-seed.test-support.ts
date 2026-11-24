// What each Space of the isolation world holds: one of every kind of thing a person keeps, made
// through the public API where one exists, every one named with a canary.
import { randomUUID } from "node:crypto";
import { callRequestClientNonce } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createThreadMessageInTransaction } from "@rakazo/db";
import type {
  IsolationApp,
  IsolationHandles,
  Person,
  Target,
} from "./dozo-isolation.test-support.js";
import { canary, rand, rpc, sendAndWait, waitUntilBotIdle } from "./dozo-isolation.test-support.js";
import { asSystem } from "./system-db.js";

const pageSource = (heading: string) =>
  `const App = () => (\n  <Page title="${heading}">\n    <Metrics metrics={[{ value: "42", label: "Users" }]} />\n  </Page>\n);\nexport default App;\n`;

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
  await waitUntilBotIdle(world, cookie, { botId: input.botId }, spaceId);
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
  // A line a review added to the bot's notes, already undone: the owner's undo answers it as it
  // is and writes nothing, so the owner's control call does not change the notes mid-sweep. Its
  // review needs a model: system insert.
  await step("learning change", async () => {
    const id = randomUUID();
    await system.$executeRaw`
      INSERT INTO dozo_learning_changes (id, "botId", "spaceId", kind, "after", "undoneAt")
      VALUES (${id}, ${botId}, ${spaceId}, 'add', ${mark("learnednote")}, CURRENT_TIMESTAMP)`;
    ids.learningChangeId = id;
  });
}

/**
 * A run queued on the target's second bot, made fresh, and kept waiting the way the product's own
 * waiting runs are: another run of the bot holds its computer. The recovery scan leaves a queued run
 * whose bot's computer lease belongs to another run (`findRunRecoveryBlockers`,
 * packages/adapters/src/run-recovery.ts), and a start that does reach it finds the computer taken
 * and puts the run back to waiting (`startClaimedAttempt`, packages/adapters/src/run-attempt.ts).
 * The lease reaches less than two lease lengths ahead, so it is not taken for an abandoned
 * takeover hold, and it names no run, so it is the holder's alone to release: `releaseWaitingRun`.
 */
export async function seedWaitingRun(db: PrismaClient, owner: Person, target: Target) {
  const system = asSystem(db);
  const { spaceId, ids } = target;
  const botId = ids.secondBotId!;
  const { computerId } = await system.bot.findUniqueOrThrow({
    where: { id: botId },
    select: { computerId: true },
  });
  if (!computerId) throw new Error("the target's second bot has no computer");
  const holder = {
    runId: "iso-computer-holder",
    fence: 1,
    expiresAt: new Date(Date.now() + 9 * 60_000),
  };
  await system.computerExecutionLease.upsert({
    where: { computerId_botId: { computerId, botId } },
    create: { computerId, botId, ...holder },
    update: holder,
  });
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

/** Lets go of the computer `seedWaitingRun` held, so later work of the bot starts as usual. */
export async function releaseWaitingRun(db: PrismaClient, target: Target) {
  await asSystem(db).computerExecutionLease.deleteMany({
    where: { botId: target.ids.secondBotId!, runId: "iso-computer-holder" },
  });
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
