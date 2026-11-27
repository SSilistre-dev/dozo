// The cross-tenant isolation world: real accounts signed up through the app, a personal Space P and
// a shared Space S of A, each holding one of every kind of thing a person keeps, every one carrying
// a canary string. Callers that must never see P or S read and write through the real HTTP surface;
// a response that carries a canary, or a row of P or S that changed, is a leak.
// This file holds the world's shapes, its canaries and the app's requests. What each Space holds
// is planted by dozo-isolation-seed.test-support.ts, the world is built by
// dozo-isolation-world.test-support.ts, and its rows are compared by
// dozo-isolation-snapshot.test-support.ts.
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { createApp } from "@rakazo/api/app";
import { LabFeatureSchema } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
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
  | "deviceId"
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
  | "learningChangeId"
  | "externalConversationId"
  | "soloOrganizationId"
  | "removableDocumentId"
  | "waitBotId"
  | "waitingRunId"
  | "waitingMessageId"
  | "attachmentArtifactId"
  | "invitationId"
  | "cancelInvitationId"
  | "meetingId"
  | "shareMeetingId"
  | "deleteMeetingId"
  | "pageGrantId"
  | "pageCommentId"
  | "filePath"
  // The owner's account and organization, not one Space: the same thing in P's and S's pools.
  | "apiKeyId"
  | "organizationModelConnectionId"
  | "organizationConnectionId"
  | "organizationLoginId";

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

/**
 * What the app sent out while the world ran: jobs, push notifications and mail, in order. `by` is
 * the cookie of the request whose work sent it (`anonymous` without one).
 */
export interface IsolationRecords {
  jobs: { by: string; text: string }[];
  notifications: { by: string; userId: string; text: string }[];
  mail: { by: string; to: string; text: string }[];
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
 * shows such a bot or group name blank, which would hide the canary from the scan. No vowel and
 * no "c" either: a message is the scripted runtime's script, and a canary that happened to spell
 * one of its words ("crm", "login") would start a turn that waits for an answer.
 */
const RAND_LETTERS = "bdfghjklmnpqrstvwxz";
export const rand = () =>
  Array.from(randomBytes(10), (byte) => RAND_LETTERS[byte % RAND_LETTERS.length]).join("");

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
  // The server turned the agent on for a person's computer (the file in its data folder, which the
  // agent code reads from DATA_DIR): for this world's life only, then DATA_DIR is as it was.
  writeFileSync(path.join(dataDir, "dozo-agent-tools"), "codex-agent\n");
  const earlierDataDir = process.env.DATA_DIR;
  const restore = () => {
    if (earlierDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = earlierDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  };
  process.env.DATA_DIR = dataDir;
  let handles: IsolationHandles;
  try {
    const { createApp } = await import("@rakazo/api/app");
    handles = await createApp({
      databaseUrl,
      encryptionKey: "offline-isolation-encryption-key",
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      wakeupDriver: "memory",
      signupsEnabled: "true",
      ...overrides,
    });
  } catch (error) {
    // A setup that stops halfway leaves nothing behind.
    restore();
    throw error;
  }
  return {
    handles,
    async cleanup() {
      try {
        await handles.stop();
      } finally {
        restore();
      }
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

export async function person(
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

/** Sends as `cookie` and waits until the bot's run for it is over (see `waitUntilBotIdle`). */
export async function sendAndWait(
  world: { app: IsolationApp; handles: IsolationHandles },
  cookie: string,
  target: Record<string, string>,
  text: string,
  spaceId: string,
) {
  await rpc(world, cookie, "threads/send", { ...target, text }, spaceId);
  await waitUntilBotIdle(world, cookie, target, spaceId);
}

const ENDED_RUN = ["completed", "failed", "cancelled"];

/**
 * Waits until the chat's run has ended and has let go of the bot's computer. A run reads as ended
 * before its attempt releases the computer, so a message sent in between starts a run that finds
 * the computer held and waits for the release to start it; one that checks just before the release
 * and settles just after it is never started, and stays queued until a recovery sweep finds it. The
 * next send waits for the release, so its run never meets the last one's hold.
 */
export async function waitUntilBotIdle(
  world: { app: IsolationApp; handles: IsolationHandles },
  cookie: string,
  target: Record<string, string>,
  spaceId: string,
) {
  const db = asSystem(world.handles.prisma);
  const botId = target.botId ?? target.chatBotId;
  await vi.waitFor(
    async () => {
      const snap = await rpc<{ run?: { status: string } | null }>(
        world,
        cookie,
        "threads/get",
        target,
        spaceId,
      );
      if (snap.run && !ENDED_RUN.includes(snap.run.status))
        throw new Error(`the run did not end (${snap.run.status})`);
      const held = await db.computerExecutionLease.findMany({
        where: { botId, expiresAt: { gt: new Date() } },
        select: { runId: true },
      });
      const endedHolder = await db.run.count({
        where: { id: { in: held.map((lease) => lease.runId) }, status: { in: ENDED_RUN } },
      });
      if (endedHolder) throw new Error("the ended run still holds the bot's computer");
    },
    { timeout: 30_000, interval: 100 },
  );
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
