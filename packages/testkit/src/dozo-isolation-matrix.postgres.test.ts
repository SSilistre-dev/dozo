// Cross-tenant isolation over the whole RPC surface. Every procedure of the contract is called by
// every caller that must not reach P (A's personal Space) or S (A's shared Space), with inputs
// that name P's or S's things; no answer may carry one of their canaries, and nothing P or S
// holds may change. A new procedure is swept by itself: the list is read from the contract.
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appContract } from "@rakazo/contracts";
import { callRequestClientNonce } from "@rakazo/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type {
  IsolationApp,
  IsolationWorld,
  PoolKey,
  Target,
} from "./dozo-isolation.test-support.js";
import {
  buildIsolationWorld,
  confirmIdentity,
  findCanaries,
  ISOLATION_LOGINS,
  readAnswer,
  seedWaitingRun,
  snapshot,
  snapshotDiff,
} from "./dozo-isolation.test-support.js";
import type { IsolationExemption } from "./dozo-isolation-exemptions.js";
import {
  DESIGNED_SHARING,
  ISOLATION_EXEMPTIONS,
  NEVER_SHARED_KINDS,
} from "./dozo-isolation-exemptions.js";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;

const CONCURRENCY = 8;
/** Procedures the owner must see P's canaries through: reads of every kind planted, one streamed. */
const CONTROL_PATHS = ["threads/messages", "threads/subscribe", "bots/get", "artifacts/getById"];
/** Only this answers without a session. */
const PUBLIC_PATHS = new Set(["health"]);

// --- Enumeration -------------------------------------------------------------------------------

type ZodLike = {
  _zod: { def: Record<string, unknown> & { type: string } };
  safeParse(value: unknown): { success: boolean };
};
type Procedure = { path: string; input: ZodLike | undefined };

function contractProcedures(): Procedure[] {
  const out: Procedure[] = [];
  const walk = (node: unknown, at: string[]) => {
    if (!node || typeof node !== "object") return;
    if ("~orpc" in node) {
      const def = (node as { "~orpc": { inputSchema?: ZodLike } })["~orpc"];
      out.push({ path: at.join("/"), input: def.inputSchema });
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, [...at, key]);
  };
  walk(appContract, []);
  return out;
}

// --- Input generation --------------------------------------------------------------------------

/** Field name to the kind of thing it names. `id`, `skillId` and `name` depend on the namespace. */
const FIELD_KEYS: Record<string, PoolKey> = {
  botId: "botId",
  chatBotId: "botId",
  assigneeBotId: "botId",
  botIds: "botId",
  expectedBotIds: "botId",
  threadId: "threadId",
  chatId: "chatId",
  groupId: "groupId",
  messageId: "messageId",
  replyToMessageId: "messageId",
  lastMessageId: "messageId",
  runId: "runId",
  runIds: "runId",
  routineId: "routineId",
  routineIds: "routineId",
  serverIds: "mcpServerId",
  documentId: "documentId",
  pageId: "pageId",
  artifactId: "artifactId",
  artifactIds: "artifactId",
  familyId: "artifactFamilyId",
  boardId: "boardId",
  ticketId: "ticketId",
  sectionId: "sectionId",
  itemId: "itemId",
  tokenId: "tokenId",
  spaceId: "spaceId",
  spaceIds: "spaceId",
  organizationId: "organizationId",
  userId: "memberUserId",
  expectedUserId: "ownerUserId",
  actorId: "ownerUserId",
  callId: "callId",
  credentialId: "credentialId",
  loginId: "loginId",
  versionId: "versionId",
  computerId: "computerId",
  leaseId: "leaseId",
  serverId: "mcpServerId",
  sessionId: "mcpSessionId",
  identityId: "identityId",
  membershipId: "membershipId",
  externalConversationId: "externalConversationId",
};
/** Fields that name another kind of thing in one procedure than everywhere else. */
const PATH_FIELD_KEYS: Record<string, Record<string, PoolKey>> = {
  "threads/declineCall": { callId: "declineCallId" },
  "notifications/declineIncomingCall": { callId: "incomingCallId" },
  "memory/remove": { documentId: "removableDocumentId" },
  "organizations/rename": { organizationId: "soloOrganizationId" },
  "organizations/remove": { organizationId: "soloOrganizationId" },
  "dozoQueue/cancelWaiting": { runId: "waitingRunId", messageId: "waitingMessageId" },
  "dozoLearning/undo": { changeId: "learningChangeId" },
  "computer/readFile": { path: "filePath" },
  "computer/downloadFile": { path: "filePath" },
  "connections/complete": { connectionId: "connectionId" },
  "connections/rename": { connectionId: "connectionId" },
  "connections/revoke": { connectionId: "connectionId" },
  "messaging/connections/respond": { connectionId: "messagingConnectionId" },
  "messaging/connections/revoke": { connectionId: "messagingConnectionId" },
  "messaging/installations/remove": { id: "messagingInstallationId" },
  "computer/dismissUpdate": { id: "computerUpdateId" },
  "dozoAdmin/stopComputer": { computerId: "computerId" },
  // A mention chip names a bot (the first kind of chip).
  "threads/send": { id: "botId" },
  "threads/sendWithRoutines": { id: "botId" },
};
/** A field whose name says it names something; each one must be filled from the target's things. */
const ID_FIELD = /Id$|Ids$|^id$/;
const ID_BY_NAMESPACE: Record<string, PoolKey> = {
  dozoAccessTokens: "tokenId",
  agentSecrets: "agentSecretId",
  tickets: "ticketId",
  bots: "botId",
  availability: "agentSkillId",
  routines: "routineId",
  capabilities: "capabilityId",
  approvalRules: "approvalRuleId",
  dozoCommandRules: "commandRuleId",
  mcp: "mcpServerId",
};
/** Procedures that act only on a taught skill whose recording has ended. */
const DRAFT_SKILL_PATHS = new Set([
  "skills/updateDraft",
  "skills/save",
  "skills/testRun",
  "dozoTeach/save",
  "dozoTeach/test",
  "dozoTeach/decideSaved",
]);
const SECRET_NAME_PATHS = new Set([
  "vault/reveal",
  "vault/activity",
  "vault/remove",
  "botSecrets/remove",
]);

function poolKeyFor(procedure: string, field: string): PoolKey | undefined {
  const namespace = procedure.split("/")[0]!;
  const special = PATH_FIELD_KEYS[procedure]?.[field];
  if (special) return special;
  if (field === "id") return ID_BY_NAMESPACE[namespace];
  if (field === "skillId") {
    if (namespace === "agentSkills" || namespace === "dozoOrganizationLibrary")
      return "agentSkillId";
    return DRAFT_SKILL_PATHS.has(procedure) ? "draftSkillId" : "taughtSkillId";
  }
  if (field === "name" && SECRET_NAME_PATHS.has(procedure)) return "secretName";
  return FIELD_KEYS[field];
}

const FAIL = Symbol("cannot generate");
const OMIT = Symbol("omit");
type Filled = unknown | typeof FAIL | typeof OMIT;

/** A week ahead: a time the product takes as a future one (a snooze, a reminder). */
const FUTURE = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();
const STRINGS = [
  "x",
  "https://example.test/",
  FUTURE,
  "probe@example.test",
  "0 9 * * 1",
  "UTC",
  "00000000-0000-4000-8000-000000000000",
  "a".repeat(32),
  "a".repeat(64),
  "AGENTS.md",
];
const NUMBERS = [1, 0, 60, 100, 1000, 100_000, -1];
/** Realistic values for fields whose plain string the handler refuses before it looks anything up. */
const FIELD_VALUES: Record<string, string | boolean> = {
  /** Shared, so the organization library holds the skill its later calls name. */
  shared: true,
  mimeType: "text/plain",
  contentBase64: Buffer.from("iso-probe\n").toString("base64"),
  origin: "https://example.test",
  crons: "0 9 * * 1",
  optionId: "day",
  value: "placeholder-not-a-secret",
  content: "---\nname: iso-probe\ndescription: iso-probe\n---\niso-probe\n",
};

type Resolve = (key: PoolKey) => string | undefined;
/** Inputs tried per procedure and target, before the mixed ones. */
const MAX_VARIANTS = 4;

/** Whether `schema` holds a field that names something, at any depth. */
function holdsIdField(schema: ZodLike, seen = new Set<unknown>()): boolean {
  if (seen.has(schema)) return false;
  seen.add(schema);
  const def = schema._zod.def;
  const inner = (name: string) => holdsIdField(def[name] as ZodLike, seen);
  switch (def.type) {
    case "object":
      return Object.entries(def.shape as Record<string, ZodLike>).some(
        ([key, child]) => ID_FIELD.test(key) || holdsIdField(child, seen),
      );
    case "optional":
    case "default":
    case "prefault":
    case "nullable":
    case "nonoptional":
    case "readonly":
    case "catch":
      return inner("innerType");
    case "pipe":
      return inner("in");
    case "lazy":
      return holdsIdField((def.getter as () => ZodLike)(), seen);
    case "intersection":
      return inner("left") || inner("right");
    case "union":
      return (def.options as ZodLike[]).some((option) => holdsIdField(option, seen));
    case "array":
      return inner("element");
    case "record":
      return inner("valueType");
    case "tuple":
      return (def.items as ZodLike[]).some((item) => holdsIdField(item, seen));
    default:
      return false;
  }
}

/** Every field name in `schema` that says it names something, at any depth. */
function idFields(schema: ZodLike | undefined, out = new Set<string>(), seen = new Set<unknown>()) {
  if (!schema || seen.has(schema)) return out;
  seen.add(schema);
  const def = schema._zod.def;
  const inner = (name: string) => idFields(def[name] as ZodLike, out, seen);
  switch (def.type) {
    case "object":
      for (const [key, child] of Object.entries(def.shape as Record<string, ZodLike>)) {
        if (ID_FIELD.test(key)) out.add(key);
        idFields(child, out, seen);
      }
      break;
    case "optional":
    case "default":
    case "prefault":
    case "nullable":
    case "nonoptional":
    case "readonly":
    case "catch":
      inner("innerType");
      break;
    case "pipe":
      inner("in");
      break;
    case "lazy":
      idFields((def.getter as () => ZodLike)(), out, seen);
      break;
    case "intersection":
      inner("left");
      inner("right");
      break;
    case "union":
      for (const option of def.options as ZodLike[]) idFields(option, out, seen);
      break;
    case "array":
      inner("element");
      break;
    case "record":
      inner("valueType");
      break;
    case "tuple":
      for (const item of def.items as ZodLike[]) idFields(item, out, seen);
      break;
  }
  return out;
}

class Generator {
  used = new Set<PoolKey>();
  /** The fields that got one of the target's things. */
  filled = new Set<string>();
  /** How many values came from the target's things so far. */
  hits = 0;
  constructor(
    private readonly procedure: string,
    private readonly resolve: Resolve,
    /** Fills optional fields too, for an input whose refinement wants one of them. */
    private readonly fillAll = false,
  ) {}

  /** A name of this procedure's own, so one procedure's new thing never clashes with another's. */
  private get probe() {
    return `iso-${this.procedure.replace(/[^a-z]/gi, "").toLowerCase()}`.slice(0, 32);
  }

  private id(field: string | undefined): string | undefined {
    if (!field) return undefined;
    const key = poolKeyFor(this.procedure, field);
    const value = key ? this.resolve(key) : undefined;
    if (key && value) {
      this.used.add(key);
      this.filled.add(field);
      this.hits++;
    }
    return value;
  }

  fill(schema: ZodLike, field?: string): Filled {
    const def = schema._zod.def;
    const inner = (name: string) => def[name] as ZodLike;
    switch (def.type) {
      case "optional":
      case "default":
      case "prefault":
        // Left out unless it names something (an optional id is where a foreign id goes) or has a
        // realistic value (a site the input's own refinement asks for).
        if (field === undefined) return this.fill(inner("innerType"), field);
        if (
          this.fillAll ||
          poolKeyFor(this.procedure, field) ||
          field in FIELD_VALUES ||
          holdsIdField(inner("innerType"))
        ) {
          const value = this.fill(inner("innerType"), field);
          return value === FAIL || !schema.safeParse(value).success ? OMIT : value;
        }
        return OMIT;
      case "nullable": {
        const value = this.fill(inner("innerType"), field);
        return value === FAIL || value === OMIT ? null : value;
      }
      case "nonoptional":
      case "readonly":
      case "catch":
        return this.fill(inner("innerType"), field);
      case "pipe":
        return this.fill(inner("in"), field);
      case "lazy":
        return this.fill((def.getter as () => ZodLike)(), field);
      case "object": {
        const out: Record<string, unknown> = {};
        for (const [key, child] of Object.entries(def.shape as Record<string, ZodLike>)) {
          const value = this.fill(child, key);
          if (value === FAIL) return FAIL;
          if (value !== OMIT) out[key] = value;
        }
        return out;
      }
      case "intersection": {
        const left = this.fill(inner("left"), field);
        const right = this.fill(inner("right"), field);
        if (left === FAIL || right === FAIL) return FAIL;
        return { ...(left as object), ...(right as object) };
      }
      case "union": {
        for (const option of this.preferIds(def.options as ZodLike[])) {
          const value = this.fill(option, field);
          if (value !== FAIL && value !== OMIT && option.safeParse(value).success) return value;
        }
        return FAIL;
      }
      case "string": {
        const id = this.id(field);
        const hint = field === undefined ? undefined : FIELD_VALUES[field];
        for (const value of [
          id,
          typeof hint === "string" ? hint : undefined,
          this.probe,
          ...STRINGS,
        ].filter((item) => item !== undefined))
          if (schema.safeParse(value).success) return value;
        return FAIL;
      }
      case "number":
      case "int":
        return NUMBERS.find((value) => schema.safeParse(value).success) ?? FAIL;
      case "boolean":
        return field !== undefined && typeof FIELD_VALUES[field] === "boolean"
          ? FIELD_VALUES[field]
          : false;
      case "literal":
        return (def.values as unknown[])[0];
      case "enum":
        return Object.values(def.entries as Record<string, unknown>)[0];
      case "array": {
        const id = this.id(field);
        // A list of bots names every bot of the target's: a group's members, a Space's roster.
        const others =
          id && field && poolKeyFor(this.procedure, field) === "botId"
            ? (this.procedure === "bots/reorder"
                ? (["secondBotId", "waitBotId"] as const)
                : (["secondBotId"] as const)
              )
                .map((key) => this.resolve(key))
                .filter((value): value is string => Boolean(value))
            : [];
        if (id && others.length && schema.safeParse([id, ...others]).success)
          return [id, ...others];
        if (id && schema.safeParse([id]).success) return [id];
        const before = this.hits;
        const element = this.fill(inner("element"), field);
        const one = element !== FAIL && schema.safeParse([element]).success;
        // An element that names one of the target's things goes in, so its id travels.
        const named = this.hits > before;
        if (one && (this.fillAll || named || (field !== undefined && field in FIELD_VALUES)))
          return [element];
        if (schema.safeParse([]).success) return [];
        return one ? [element] : FAIL;
      }
      case "tuple": {
        const items = (def.items as ZodLike[]).map((item) => this.fill(item));
        return items.includes(FAIL) ? FAIL : items;
      }
      case "record":
        return {};
      case "any":
      case "unknown":
        return {};
      case "null":
        return null;
      default:
        return FAIL;
    }
  }

  /** Union options that name something first, so the foreign id travels when one can. */
  private preferIds(options: ZodLike[]): ZodLike[] {
    const names = (option: ZodLike) =>
      option._zod.def.type === "object"
        ? Object.keys(option._zod.def.shape as object).some((key) =>
            poolKeyFor(this.procedure, key),
          )
        : holdsIdField(option);
    return [...options.filter(names), ...options.filter((option) => !names(option))];
  }
}

/** The fields of a top-level object input that are optional and name something. */
function optionalIdFields(procedure: string, schema: ZodLike): string[] {
  let def = schema._zod.def;
  while (["optional", "pipe", "default"].includes(def.type)) {
    def = ((def.innerType ?? def.in) as ZodLike)._zod.def;
  }
  const objects =
    def.type === "intersection"
      ? [(def.left as ZodLike)._zod.def, (def.right as ZodLike)._zod.def]
      : [def];
  const fields: string[] = [];
  for (const object of objects) {
    if (object.type !== "object") continue;
    for (const [key, child] of Object.entries(object.shape as Record<string, ZodLike>)) {
      if (["optional", "default"].includes(child._zod.def.type) && poolKeyFor(procedure, key))
        fields.push(key);
    }
  }
  return fields;
}

/** `filled`: the id fields that got one of the target's things. */
type Variant = { label: string; input: unknown; keys: Set<PoolKey>; filled?: Set<string> };

/**
 * Valid inputs for `procedure` naming `target`'s things: one per top-level union option, and for
 * an object whose refinement wants one of several optional ids (a chat names its bot, group or
 * extra chat), one per valid choice. `null` when no valid input can be made.
 */
function generateInputs(procedure: Procedure, resolve: Resolve): Variant[] | null {
  const schema = procedure.input;
  if (!schema) return [{ label: "no input", input: undefined, keys: new Set() }];
  const variants: Variant[] = [];
  const add = (label: string, make: (generator: Generator) => Filled, fillAll = false) => {
    if (variants.length >= MAX_VARIANTS) return;
    const generator = new Generator(procedure.path, resolve, fillAll);
    const input = inChat(make(generator), generator, resolve);
    if (input === FAIL || input === OMIT || !schema.safeParse(input).success) return;
    const seen = JSON.stringify(input);
    if (variants.some((variant) => JSON.stringify(variant.input) === seen)) return;
    // Only what the input still names: a choice of one optional id drops the others.
    const keys = new Set(
      [...generator.used].filter((key) => seen.includes(JSON.stringify(resolve(key)))),
    );
    variants.push({ label, input, keys, filled: generator.filled });
  };

  let top = schema._zod.def;
  while (["optional", "pipe"].includes(top.type))
    top = ((top.innerType ?? top.in) as ZodLike)._zod.def;
  if (top.type === "union") {
    for (const [index, option] of (top.options as ZodLike[]).entries())
      add(`option ${index}`, (generator) => generator.fill(option));
    if (variants.length) return variants;
  }

  add("all ids", (generator) => generator.fill(schema));
  if (variants.length) return variants;
  const optional = optionalIdFields(procedure.path, schema);
  const without = (keep: string[]) => (generator: Generator) => {
    const value = generator.fill(schema);
    if (!value || typeof value !== "object") return value;
    const copy = { ...(value as Record<string, unknown>) };
    for (const field of optional) if (!keep.includes(field)) delete copy[field];
    return copy;
  };
  for (const field of optional) add(field, without([field]));
  for (const [i, first] of optional.entries())
    for (const second of optional.slice(i + 1)) add(`${first}+${second}`, without([first, second]));
  add("no ids", without([]));
  if (!variants.length) add("every optional field", (generator) => generator.fill(schema), true);
  return variants.length ? variants : null;
}

/** A message named with the extra chat is that chat's own message. */
function inChat(input: Filled, generator: Generator, resolve: Resolve): Filled {
  if (!input || typeof input !== "object") return input;
  const fields = input as Record<string, unknown>;
  const message = resolve("chatMessageId");
  if (!fields.chatId || !message || fields.messageId !== resolve("messageId")) return input;
  generator.used.add("chatMessageId");
  return { ...fields, messageId: message };
}

/** `input` with every target id of a kind in `kinds` swapped for the caller's own id of that kind. */
function withOwn(input: unknown, target: Target, own: Target, kinds: Set<PoolKey>): unknown {
  const swap = new Map<string, string>();
  for (const kind of kinds) {
    const theirs = target.ids[kind];
    const mine = own.ids[kind];
    if (theirs && mine) swap.set(theirs, mine);
  }
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return swap.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(input);
}

/**
 * For an input naming two kinds of things: each kind the target's in turn and the rest the
 * caller's own, so a check on one id cannot vouch for another (B's routine pointed at A's chat).
 */
function mixedVariants(base: Variant, target: Target, own: Target): Variant[] {
  if (base.keys.size < 2) return [];
  return [...base.keys].map((foreign) => ({
    label: `${base.label}, only ${foreign} foreign`,
    input: withOwn(
      base.input,
      target,
      own,
      new Set([...base.keys].filter((key) => key !== foreign)),
    ),
    keys: new Set([foreign]),
  }));
}

const DESTRUCTIVE =
  /^(remove|delete|archive|revoke|clear|leave|cancel|disconnect|unlink|reset|signOut|end|unregister|unban|ban|setSuspended|dismiss|decline|stop|unpin)/i;

/** Procedures that only read, by the last word of their path; the owner's control reads them first. */
const READ =
  /^(get|list|messages|head|subscribe|status|pins|query|export|markdown|csv|breakdown|summary|items|events|history|budget|snapshot|revisable|routineChat|getById|bot|comments|preview|files|readFile)/i;

/** Whether some generated input for `procedure` names one of `target`'s things. */
function namesTarget(procedure: Procedure, target: Target) {
  return (generateInputs(procedure, (key) => target.ids[key]) ?? []).some(
    (variant) => variant.keys.size > 0,
  );
}

/** Whether some generated input for `procedure` names `target`'s thing of kind `key`. */
function namesKey(procedure: Procedure, target: Target, key: PoolKey) {
  return (generateInputs(procedure, (wanted) => target.ids[wanted]) ?? []).some((variant) =>
    variant.keys.has(key),
  );
}

/**
 * Writes the owner's control makes first, as its other writes change what they need: the Space's
 * whole roster (its creates grow it) and the live recording (its computer calls end it).
 */
const OWNER_WRITES_FIRST = new Set(["bots/reorder", "skills/appendEvent"]);

/**
 * Removals the owner's control makes last, in this order: everything else hangs off what they
 * remove, so a removal made earlier would answer the rest "not found" for the owner too.
 */
const OWNER_REMOVES_LAST = [
  "messaging/identities/unlink",
  "threads/clear",
  "dozoChats/archive",
  "groups/archive",
  "groups/remove",
  "bots/archive",
  "bots/remove",
];

function isDestructive(path: string) {
  return DESTRUCTIVE.test(path.split("/").pop() ?? "");
}

// --- The sweep ---------------------------------------------------------------------------------

type Caller = {
  name: string;
  cookie?: string;
  spaceId?: string;
  target: Target;
  own?: Target;
  /**
   * `refused`: every protected call must answer 401 at membership. `no-canary`: none of the
   * target's canaries or ids may come back. `shared`: a member of the target Space, who may see
   * a canary only through a procedure the designed-sharing table lists for its kind, and never
   * one of a kind no member may see.
   */
  expect: "refused" | "no-canary" | "shared";
  /** Shares a Space with the owner, so knows the owner's name, address and id by design. */
  knowsOwner?: boolean;
  /** Also compares each procedure's first answer naming the target with one for made-up ids. */
  compare?: boolean;
};

/** `foreign`: the input names at least one of the target's things. */
type Call = {
  caller: Caller;
  path: string;
  variant: string;
  input: unknown;
  foreign: boolean;
  /** Compare this answer with the one for the same input with made-up ids. */
  compare?: boolean;
};
/** `detail`: the refusal's code and message, for a status of 400 or more. */
type Outcome = Call & {
  status: number;
  matched: string[];
  streamed: boolean;
  detail: string;
  /** The target's ids the answer carries that the caller did not send. */
  ids: string[];
  /** The answer for made-up ids of the same shape, when it differs from this one. */
  twin?: { existing: string; missing: string };
};

function refusalDetail(status: number, text: string): string {
  if (status < 400) return "";
  try {
    const { json } = JSON.parse(text) as { json?: { code?: string; message?: string } };
    return `${json?.code ?? "?"}: ${json?.message ?? ""}`.slice(0, 200);
  } catch {
    return text.slice(0, 200);
  }
}

async function pool<T, R>(
  items: T[],
  run: (item: T) => Promise<R>,
  concurrency = CONCURRENCY,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await run(items[index]!);
      }
    }),
  );
  return results;
}

/** `ownToo`: also each input with every id the caller's own, to read back what its writes left. */
function callsFor(caller: Caller, procedures: Procedure[], ownToo = false): Call[] {
  const calls: Call[] = [];
  for (const procedure of procedures) {
    const resolve: Resolve = (key) => caller.target.ids[key];
    const variants = generateInputs(procedure, resolve) ?? [];
    let compared = false;
    for (const variant of variants) {
      const base = { caller, path: procedure.path, variant: variant.label, input: variant.input };
      const foreign = variant.keys.size > 0;
      const compare = Boolean(caller.compare && foreign && !compared);
      if (compare) compared = true;
      calls.push({ ...base, foreign, compare });
      if (caller.own)
        for (const mixed of mixedVariants(variant, caller.target, caller.own))
          calls.push({ ...base, variant: mixed.label, input: mixed.input, foreign: true });
      if (caller.own && ownToo && variant.keys.size)
        calls.push({
          ...base,
          variant: `${variant.label}, all own`,
          input: withOwn(variant.input, caller.target, caller.own, variant.keys),
          foreign: false,
        });
    }
  }
  return calls;
}

/** Ids of the target that are not the caller's to know. */
function foreignIds(caller: Caller): string[] {
  const own = new Set<string>();
  if (caller.own && caller.own !== caller.target)
    // A's other organization is in S's pool for the organization calls, not S's to show.
    for (const [key, value] of Object.entries(caller.own.ids))
      if (value && !(caller.own.label === "S" && key === "soloOrganizationId")) own.add(value);
  return [
    ...new Set(
      Object.values(caller.target.ids).filter(
        (value): value is string => Boolean(value) && value!.length >= 8 && !own.has(value!),
      ),
    ),
  ];
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * A made-up value of the same shape: a UUID for a UUID, else the same first character and then
 * the same letters, digits and marks (a cuid keeps its leading `c`).
 */
function lookalike(value: string): string {
  if (new RegExp(`^${UUID.source}$`, "i").test(value)) return randomUUID();
  const bytes = randomBytes(value.length);
  return [...value]
    .map((char, index) => {
      if (index === 0) return char;
      const byte = bytes[index]!;
      if (/[a-z]/.test(char)) return String.fromCharCode(97 + (byte % 26));
      if (/[A-Z]/.test(char)) return String.fromCharCode(65 + (byte % 26));
      if (/[0-9]/.test(char)) return String(byte % 10);
      return char;
    })
    .join("");
}

function swapValues(input: unknown, swap: Map<string, string>): unknown {
  const walk = (value: unknown): unknown => {
    if (typeof value === "string") return swap.get(value) ?? value;
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object")
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, walk(item)]));
    return value;
  };
  return walk(input);
}

/** An answer with the ids it names, times and generated values made alike. */
function normalised(status: number, text: string, values: string[]) {
  let out = text;
  for (const value of values) out = out.split(value).join("<id>");
  out = out
    .replace(UUID, "<uuid>")
    .replace(/\b[a-z0-9]{24,32}\b/g, "<id>")
    .replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<time>")
    .replace(/\d{10,}/g, "<n>");
  return `${status} ${out.slice(0, 400)}`;
}

type SweepOptions = {
  /** Also each input with every id the caller's own (see `callsFor`). */
  ownToo?: boolean;
  concurrency?: number;
  /** Waits before each call until the world is settled enough for it. */
  settle?: (call: Call) => Promise<void>;
  /**
   * Leaves the id scan out: in the read-back pass every target id was sent by the caller in an
   * earlier request, and the caller's own audit log names what it tried, by design.
   */
  noIdScan?: boolean;
};

async function sweep(
  app: IsolationApp,
  callers: Caller[],
  procedures: Procedure[],
  { ownToo = false, concurrency = CONCURRENCY, settle, noIdScan = false }: SweepOptions = {},
) {
  for (const caller of callers) if (caller.cookie) await confirmIdentity(app, caller.cookie);
  const reads = procedures.filter((procedure) => !isDestructive(procedure.path));
  const destructive = procedures.filter((procedure) => isDestructive(procedure.path));
  const outcomes: Outcome[] = [];
  const foreignByCaller = new Map(callers.map((caller) => [caller, foreignIds(caller)]));
  // Reads and writes first, destructive procedures after, so a foreign delete that worked still
  // shows in the snapshot instead of hiding the rows the reads would have leaked.
  for (const phase of [reads, destructive]) {
    const calls = callers.flatMap((caller) => callsFor(caller, phase, ownToo));
    outcomes.push(
      ...(await pool(
        calls,
        async (call): Promise<Outcome> => {
          await settle?.(call);
          const { caller } = call;
          const answer = await readAnswer(
            app,
            caller.cookie,
            call.path,
            call.input,
            caller.spaceId,
          );
          const whole = `${answer.text}\n${answer.headers}`;
          const scan = [
            ...caller.target.canaries,
            ...(caller.knowsOwner ? [] : (caller.target.identityCanaries ?? [])),
          ];
          const sent = JSON.stringify(call.input ?? null);
          const ids =
            caller.expect === "shared" || noIdScan
              ? []
              : foreignByCaller
                  .get(caller)!
                  .filter(
                    (value) =>
                      whole.includes(value) && !sent.includes(value) && value !== caller.spaceId,
                  );
          const outcome: Outcome = {
            ...call,
            status: answer.status,
            streamed: answer.streamed,
            matched: findCanaries(whole, scan),
            detail: refusalDetail(answer.status, answer.text),
            ids,
          };
          if (call.compare) {
            const named = Object.values(caller.target.ids).filter(
              (value): value is string => Boolean(value) && sent.includes(JSON.stringify(value)),
            );
            const swap = new Map(named.map((value) => [value, lookalike(value)]));
            const twin = await readAnswer(
              app,
              caller.cookie,
              call.path,
              swapValues(call.input, swap),
              caller.spaceId,
            );
            const values = [...swap.keys(), ...swap.values()];
            const existing = answer.streamed
              ? String(answer.status)
              : normalised(answer.status, answer.text, values);
            const missing = twin.streamed
              ? String(twin.status)
              : normalised(twin.status, twin.text, values);
            if (existing !== missing) outcome.twin = { existing, missing };
          }
          return outcome;
        },
        concurrency,
      )),
    );
  }
  return outcomes;
}

const kindOf = (target: Target, value: string) =>
  target.kinds?.[value] ??
  (target.identityCanaries?.includes(value)
    ? value.includes("@")
      ? "owneremail"
      : "ownername"
    : "unknown");

function failures(outcomes: Outcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    const { caller } = outcome;
    const where = `${outcome.path} [${outcome.variant}] as ${caller.name}: ${outcome.status}`;
    if (caller.expect === "shared") {
      for (const value of outcome.matched) {
        const kind = kindOf(caller.target, value);
        if (NEVER_SHARED_KINDS.includes(kind))
          out.push(`${where} showed ${kind}, which no member may see (${value})`);
        else if (!DESIGNED_SHARING[outcome.path]?.includes(kind))
          out.push(`${where} showed ${kind}, not in the designed sharing table (${value})`);
      }
    } else if (outcome.matched.length) out.push(`${where} leaked ${outcome.matched.join(", ")}`);
    if (outcome.ids.length) out.push(`${where} returned ids it was not sent: ${outcome.ids}`);
    if (caller.expect === "refused" && !PUBLIC_PATHS.has(outcome.path) && outcome.status !== 401)
      out.push(`${where} was not refused at membership`);
  }
  return out;
}

/**
 * Procedures whose refusal of a foreigner's existing-but-foreign id differs from the one for a
 * never-existing id of the same shape, against the known ones; and known ones that no longer do.
 */
function refusalReport(outcomes: Outcome[], exemptions = ISOLATION_EXEMPTIONS) {
  const known = new Set(
    exemptions.filter((item) => item.kind === "distinguishable").map((item) => item.path),
  );
  const differing = new Map<string, string>();
  const compared = new Set<string>();
  for (const outcome of outcomes) {
    if (!outcome.compare) continue;
    compared.add(outcome.path);
    if (outcome.twin)
      differing.set(
        outcome.path,
        `${outcome.path} as ${outcome.caller.name}: existing ${outcome.twin.existing} | never-existing ${outcome.twin.missing}`,
      );
  }
  return {
    all: [...differing.values()],
    fresh: [...differing].filter(([key]) => !known.has(key)).map(([, line]) => line),
    stale: [...known].filter((key) => compared.has(key) && !differing.has(key)),
  };
}

/** Not failures, but worth a reader's eye: server errors, and foreign ids a call accepted. */
function notable(outcomes: Outcome[]) {
  const lines = new Set<string>();
  for (const outcome of outcomes) {
    if (outcome.status >= 500)
      lines.add(`${outcome.caller.name}: ${outcome.path} answered ${outcome.status}`);
    else if (outcome.foreign && outcome.status < 300 && outcome.caller.expect === "no-canary")
      lines.add(
        `${outcome.caller.name}: ${outcome.path} [${outcome.variant}] accepted (${outcome.status}${outcome.streamed ? ", stream" : ""})`,
      );
  }
  return [...lines].sort().join("\n");
}

function summary(outcomes: Outcome[]) {
  const byCaller = new Map<string, Map<number, number>>();
  for (const outcome of outcomes) {
    const statuses = byCaller.get(outcome.caller.name) ?? new Map<number, number>();
    statuses.set(outcome.status, (statuses.get(outcome.status) ?? 0) + 1);
    byCaller.set(outcome.caller.name, statuses);
  }
  return [...byCaller]
    .map(
      ([name, statuses]) =>
        `${name}: ${[...statuses]
          .sort(([a], [b]) => a - b)
          .map(([status, count]) => `${status}x${count}`)
          .join(" ")}`,
    )
    .join("\n");
}

/**
 * Whether the owner's own call got through to what it names: an answer. A conflict (409) is not
 * proof: it is listed per procedure (`reached-409`) with why the handler found the thing first.
 * A 400, 403, 404 or server error from the owner means a foreign caller's refusal of the same
 * input proves nothing about isolation.
 */
function reaches(outcome: Outcome) {
  return outcome.status < 400;
}

const line = (outcome: Outcome) =>
  `${outcome.path} [${outcome.variant}]: ${outcome.status} ${outcome.detail}`;

/**
 * The owner's calls naming P's things that did not get through and are not exempted, and the
 * `unreached` or `reached-409` exemptions that no longer hold.
 */
function reachReport(outcomes: Outcome[]) {
  const covers = (exemption: IsolationExemption, outcome: Outcome) =>
    exemption.path === outcome.path &&
    (exemption.variant === undefined || exemption.variant === outcome.variant);
  const unreachedExemptions = ISOLATION_EXEMPTIONS.filter((item) => item.kind === "unreached");
  const conflicts = ISOLATION_EXEMPTIONS.filter((item) => item.kind === "reached-409");
  const naming = outcomes.filter((outcome) => outcome.foreign);
  const unreached = naming
    .filter(
      (outcome) =>
        !reaches(outcome) &&
        !unreachedExemptions.some((exemption) => covers(exemption, outcome)) &&
        !(outcome.status === 409 && conflicts.some((exemption) => covers(exemption, outcome))),
    )
    .map(line);
  const stale: string[] = [];
  for (const exemption of [...unreachedExemptions, ...conflicts]) {
    const covered = naming.filter((outcome) => covers(exemption, outcome));
    const label = `${exemption.path}${exemption.variant ? ` [${exemption.variant}]` : ""} (${exemption.kind})`;
    if (!covered.length) stale.push(`${label}: no owner call names P's things`);
    else if (exemption.kind === "unreached" && covered.every(reaches))
      stale.push(`${label}: the owner gets through now`);
    else if (
      exemption.kind === "reached-409" &&
      !exemption.stateDependent &&
      !covered.some((item) => item.status === 409)
    )
      stale.push(`${label}: the owner gets no conflict now`);
  }
  const reached = new Set(naming.filter(reaches).map((outcome) => outcome.path));
  return { unreached, stale, reached };
}

/**
 * Jobs, push notifications and mail sent since `from` by the work of `callers`' requests that name
 * the owner or one of `needles`: a foreign caller's calls must not make the app act for A, P or S.
 * Work the owner's own earlier requests left running (an expiry timer that fires mid-sweep on a
 * slow run) is the owner's, not a caller's.
 */
function outgoingReport(
  records: NonNullable<IsolationWorld["records"]>,
  from: { jobs: number; notifications: number; mail: number },
  callers: readonly Caller[],
  owner: { userId: string; email: string },
  needles: string[],
) {
  const cookies = new Set(callers.map((caller) => caller.cookie ?? "anonymous"));
  const theirs = (item: { by: string }) => cookies.has(item.by);
  const names = (text: string) => needles.some((value) => text.includes(value));
  return [
    ...records.jobs
      .slice(from.jobs)
      .filter((item) => theirs(item) && names(item.text))
      .map((item) => `job: ${item.text.slice(0, 300)}`),
    ...records.notifications
      .slice(from.notifications)
      .filter((item) => theirs(item) && (item.userId === owner.userId || names(item.text)))
      .map((item) => `notification to ${item.userId}: ${item.text.slice(0, 300)}`),
    ...records.mail
      .slice(from.mail)
      .filter((item) => theirs(item) && (item.to.includes(owner.email) || names(item.text)))
      .map((item) => `mail to ${item.to}: ${item.text.slice(0, 300)}`),
  ];
}

const mark = (records: NonNullable<IsolationWorld["records"]>) => ({
  jobs: records.jobs.length,
  notifications: records.notifications.length,
  mail: records.mail.length,
});

/**
 * A fresh waiting run of the target's, which the app's reconciler would start within half a
 * minute: each foreign cookie tries to cancel it at once and it must still be waiting; then its
 * owner cancels it through the same procedure, so it does not run in the middle of a sweep.
 */
async function waitingRunKept(
  world: IsolationWorld,
  cookies: string[],
  target: Target,
  spaceId: string,
) {
  const runId = await seedWaitingRun(world.db, world.A, target);
  const problems: string[] = [];
  for (const cookie of cookies) {
    const answer = await readAnswer(
      world.app,
      cookie,
      "dozoQueue/cancelWaiting",
      { runId },
      spaceId,
    );
    if (answer.status < 400) problems.push(`a foreigner cancelled ${target.label}'s waiting run`);
  }
  const run = await world.db.run.findUniqueOrThrow({ where: { id: runId } });
  if (run.status !== "queued") problems.push(`${target.label}'s waiting run is ${run.status}`);
  const own = await readAnswer(
    world.app,
    world.A.cookie,
    "dozoQueue/cancelWaiting",
    { runId },
    target.spaceId,
  );
  if (own.status !== 200) problems.push(`the owner could not cancel it: ${own.status}`);
  return problems;
}

/** The repository root, where `verifiedByCode` paths start. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/** `file:line "fragment" — filter`: the file exists and that line holds the fragment. */
function codeReferenceProblem(reference: string | undefined): string | undefined {
  const parsed = reference ? /^(\S+):(\d+) "(.+?)" — .+/.exec(reference) : null;
  if (!parsed) return `not of the form file:line "fragment" — filter`;
  const [, file, at, fragment] = parsed;
  const full = path.join(ROOT, file!);
  if (!existsSync(full)) return `${file} does not exist`;
  const text = readFileSync(full, "utf8").split("\n")[Number(at) - 1] ?? "";
  if (!text.includes(fragment!)) return `${file}:${at} does not hold "${fragment}"`;
  return undefined;
}

/** Tables a member's or guest's calls in S must leave as they were: who is in S, and A's keys. */
const ADMIN_TABLES =
  /^(space|spaceMember|member|organization|secret|agentSecret|vaultCredential|userModelCredential|billingAccount|sql:dozo_access_tokens)$/;

describeWithDatabase.each(ISOLATION_LOGINS)(
  "cross-tenant isolation over every RPC procedure ($name)",
  (login) => {
    let world: IsolationWorld;
    const procedures = contractProcedures();
    const exempt = new Map(
      ISOLATION_EXEMPTIONS.filter(
        (item) => item.kind === "input" || item.kind === "side-effect",
      ).map((item) => [item.path, item]),
    );
    const noTarget = new Map(
      ISOLATION_EXEMPTIONS.filter((item) => item.kind === "no-target").map((item) => [
        item.path,
        item,
      ]),
    );
    const swept = () => procedures.filter((procedure) => !exempt.has(procedure.path));
    const scopeOf = (...targets: Target[]) => ({
      spaceIds: targets.map((target) => target.spaceId),
      organizationIds: [
        ...new Set(
          targets.flatMap((target) => [
            target.organizationId,
            ...(target.ids.soloOrganizationId ? [target.ids.soloOrganizationId] : []),
          ]),
        ),
      ],
      userIds: [world.A.userId],
    });
    const prefix = `[isolation ${login.name}]`;

    beforeAll(async () => {
      world = await buildIsolationWorld(login.url(), { extended: true });
    }, 240_000);

    afterAll(async () => {
      await world?.stop();
    });

    it("plants canaries the designed readers see (the matrix is not vacuous)", async () => {
      const { A, C, D, E, P, S } = world;
      expect(findCanaries(`x ${P.canaries[0]} y`, P.canaries)).toEqual([P.canaries[0]]);
      for (const lead of ["", "a", "ab"])
        expect(
          findCanaries(Buffer.from(`${lead}${P.canaries[0]}\n`).toString("base64"), P.canaries),
        ).toEqual([P.canaries[0]]);
      const own = await readAnswer(
        world.app,
        A.cookie,
        "threads/messages",
        { botId: P.ids.botId },
        P.spaceId,
      );
      expect(own.status).toBe(200);
      expect(findCanaries(own.text, P.canaries).length).toBeGreaterThan(0);
      // Names the owner's later control sweep may rename: read them while they are as planted.
      for (const [procedure, input] of [
        ["bots/list", undefined],
        ["groups/get", { groupId: P.ids.groupId }],
        ["agentSkills/list", undefined],
      ] as const) {
        const answer = await readAnswer(world.app, A.cookie, procedure, input, P.spaceId);
        expect(
          findCanaries(answer.text, P.canaries).length,
          `${procedure}: ${answer.text.slice(0, 300)}`,
        ).toBeGreaterThan(0);
      }
      const me = await readAnswer(world.app, A.cookie, "me", undefined, P.spaceId);
      expect(findCanaries(me.text, P.identityCanaries ?? []).length).toBe(2);
      for (const member of [C, D]) {
        const shared = await readAnswer(
          world.app,
          member.cookie,
          "threads/messages",
          { botId: S.ids.botId },
          S.spaceId,
        );
        expect(shared.status, member.label).toBe(200);
        expect(findCanaries(shared.text, S.canaries).length, member.label).toBeGreaterThan(0);
      }
      expect((await readAnswer(world.app, E.cookie, "me", undefined, S.spaceId)).status).toBe(401);
      expect((await readAnswer(world.app, C.cookie, "me", undefined, P.spaceId)).status).toBe(401);
      console.log(`${prefix} seed notes:\n${[...P.notes, ...S.notes].join("\n")}`);
      const unseeded = [...P.notes, ...S.notes, ...world.Bown.notes].filter((note) =>
        note.includes("could not be seeded"),
      );
      expect(unseeded, "seeds that failed").toEqual([]);
    });

    it("reads every procedure from the contract and fills every id it names from the target", () => {
      const paths = new Set(procedures.map((procedure) => procedure.path));
      expect(procedures.length).toBeGreaterThan(300);
      const ids = world.P.ids;
      const missing: string[] = [];
      const stale: string[] = [];
      const unfilled: string[] = [];
      let foreign = 0;
      for (const procedure of procedures) {
        const inputs = generateInputs(procedure, (key) => ids[key]);
        const exemption = exempt.get(procedure.path);
        if (!exemption && !inputs) missing.push(procedure.path);
        if (exemption?.kind === "input" && inputs)
          stale.push(`${procedure.path}: input can be generated now`);
        if (exemption?.kind === "side-effect" && inputs?.some((variant) => variant.keys.size > 0))
          stale.push(`${procedure.path}: names a target, so it must be swept`);
        if (exemption) continue;
        if (inputs?.some((variant) => variant.keys.size > 0)) foreign++;
        // Every field that names something gets one of P's things, or says why it cannot.
        const fields = idFields(procedure.input);
        const filled = new Set((inputs ?? []).flatMap((variant) => [...(variant.filled ?? [])]));
        const allowed = noTarget.get(procedure.path)?.fields ?? [];
        for (const field of fields)
          if (!filled.has(field) && !allowed.includes(field))
            unfilled.push(`${procedure.path}: ${field}`);
        for (const field of allowed) {
          if (!fields.has(field)) stale.push(`${procedure.path}: no field ${field} (no-target)`);
          else if (filled.has(field))
            stale.push(`${procedure.path}: ${field} is filled from the target now (no-target)`);
        }
      }
      const problems: string[] = [];
      for (const exemption of ISOLATION_EXEMPTIONS) {
        if (!paths.has(exemption.path)) stale.push(`${exemption.path}: no such procedure`);
        if (
          ["unreached", "no-target", "reached-409", "distinguishable"].includes(exemption.kind) &&
          exempt.has(exemption.path)
        )
          stale.push(`${exemption.path}: ${exemption.kind}, yet not swept`);
        if (exemption.kind === "no-target" && !exemption.fields?.length)
          problems.push(`${exemption.path}: no-target names no field`);
        if (exemption.kind === "unreached") {
          const problem = codeReferenceProblem(exemption.verifiedByCode);
          if (problem) problems.push(`${exemption.path}: verifiedByCode ${problem}`);
        }
      }
      const count = (kind: IsolationExemption["kind"]) =>
        ISOLATION_EXEMPTIONS.filter((item) => item.kind === kind).length;
      console.log(
        `${prefix} procedures enumerated ${procedures.length}, swept ${swept().length}, naming a target ${foreign}, exemptions: input ${count("input")}, side-effect ${count("side-effect")}, unreached ${count("unreached")}, no-target ${count("no-target")}, reached-409 ${count("reached-409")}, distinguishable ${count("distinguishable")}`,
      );
      expect(missing, "procedures with no generated input and no exemption").toEqual([]);
      expect(unfilled, "id fields no target thing fills and no no-target entry explains").toEqual(
        [],
      );
      expect(problems, "exemptions without their proof").toEqual([]);
      expect(stale, "stale exemptions").toEqual([]);
    });

    it("turns red on each kind of leak it is meant to catch (self-test)", async () => {
      const { B, P, Bown } = world;
      const shape = procedures.find((procedure) => procedure.path === "bots/get")!.input;
      const kinds = ["read-leak", "write-mixing", "header-leak", "foreign-id", "distinguishable"];
      const fakes: Procedure[] = kinds.map((kind) => ({
        path: `isoSelfTest/${kind}`,
        input: shape,
      }));
      const original = await world.db.bot.findUniqueOrThrow({
        where: { id: P.ids.botId! },
        select: { description: true },
      });
      const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
        new Response(JSON.stringify(body), {
          status,
          headers: { "content-type": "application/json", ...headers },
        });
      // Each fake handler leaks one way; everything else goes to the real app.
      const app: IsolationApp = {
        request: async (input, init) => {
          const kind = /\/rpc\/isoSelfTest\/(.+)$/.exec(input)?.[1];
          if (!kind) return world.app.request(input, init);
          const body = JSON.parse(String(init?.body ?? "{}")) as { json?: { botId?: string } };
          const existing = body.json?.botId === P.ids.botId;
          switch (kind) {
            case "read-leak":
              return json({ json: { name: P.canaries[0] } });
            case "write-mixing":
              if (existing)
                await world.db.bot.update({
                  where: { id: P.ids.botId! },
                  data: { description: "iso-self-test-mixed" },
                });
              return json({ json: { ok: true } });
            case "header-leak":
              return json({ json: { code: "NOT_FOUND" } }, 404, {
                "content-disposition": `attachment; filename="${P.canaries[1]}"`,
              });
            case "foreign-id":
              return json({ json: { code: "NOT_FOUND", message: `see ${P.ids.threadId}` } }, 404);
            default:
              return existing
                ? json({ json: { code: "NOT_FOUND" } }, 404)
                : json({ json: { code: "BAD_REQUEST" } }, 400);
          }
        },
      };
      const caller: Caller = {
        name: "B (self-test)",
        cookie: B.cookie,
        spaceId: B.spaceId,
        target: P,
        own: Bown,
        expect: "no-canary",
        compare: true,
      };
      const before = await snapshot(world.db, scopeOf(P));
      const outcomes = await sweep(app, [caller], fakes);
      const diff = snapshotDiff(before, await snapshot(world.db, scopeOf(P)));
      await world.db.bot.update({
        where: { id: P.ids.botId! },
        data: { description: original.description },
      });
      const red = [...failures(outcomes), ...refusalReport(outcomes, []).fresh];
      const caught = (kind: string) => red.some((item) => item.startsWith(`isoSelfTest/${kind}`));
      expect(caught("read-leak"), red.join("\n")).toBe(true);
      expect(caught("header-leak"), red.join("\n")).toBe(true);
      expect(caught("foreign-id"), red.join("\n")).toBe(true);
      expect(caught("distinguishable"), red.join("\n")).toBe(true);
      expect(
        diff.some((item) => item.startsWith("bot:")),
        diff.join("\n"),
      ).toBe(true);
      // A clean fake stays green, so the four above are red for their leak only.
      expect(red.filter((item) => item.startsWith("isoSelfTest/write-mixing"))).toEqual([]);
    });

    it("keeps P and S from B, a removed member, anonymous callers and foreign Space headers", async () => {
      const { A, B, C, D, E, P, S, Bown } = world;
      const callers: Caller[] = [
        {
          name: "B on own Space, P ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: P,
          own: Bown,
          expect: "no-canary",
          compare: true,
        },
        {
          name: "B on own Space, S ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: S,
          own: Bown,
          expect: "no-canary",
          compare: true,
        },
        {
          name: "E (removed) on S",
          cookie: E.cookie,
          spaceId: S.spaceId,
          target: S,
          expect: "refused",
        },
        { name: "anonymous, P ids", spaceId: P.spaceId, target: P, expect: "refused" },
        {
          name: "B with P's header",
          cookie: B.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
        },
        {
          name: "B with S's header",
          cookie: B.cookie,
          spaceId: S.spaceId,
          target: S,
          expect: "refused",
        },
        {
          name: "C with P's header",
          cookie: C.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
          knowsOwner: true,
        },
        {
          name: "D with P's header",
          cookie: D.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
          knowsOwner: true,
        },
      ];
      const records = world.records!;
      expect(await waitingRunKept(world, [B.cookie], P, B.spaceId)).toEqual([]);
      expect(await waitingRunKept(world, [B.cookie], S, B.spaceId)).toEqual([]);
      const from = mark(records);
      const before = await snapshot(world.db, scopeOf(P, S));
      const outcomes = await sweep(world.app, callers, swept());
      console.log(
        `${prefix} statuses per caller\n${summary(outcomes)}\n${prefix} notable\n${notable(outcomes)}`,
      );
      // The read pass again, after every write: what B's mixed writes left in B's own world must not
      // bring P's or S's canaries back with it.
      const again = await sweep(
        world.app,
        callers.slice(0, 2),
        swept().filter((procedure) => !isDestructive(procedure.path)),
        { ownToo: true, noIdScan: true },
      );
      const after = await snapshot(world.db, scopeOf(P, S));
      const refusals = refusalReport(outcomes);
      console.log(
        `${prefix} answers that tell an existing foreign id from a missing one\n${refusals.all.join("\n")}`,
      );
      const needles = [A.userId, A.email, ...foreignIds(callers[0]!), ...foreignIds(callers[1]!)];
      expect([...failures(outcomes), ...failures(again)]).toEqual([]);
      expect(refusals.fresh, "distinguishable refusals not listed as known").toEqual([]);
      expect(refusals.stale, "known distinguishable refusals that no longer differ").toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
      expect(
        outgoingReport(records, from, callers, A, needles),
        "jobs, notifications or mail for A, P or S",
      ).toEqual([]);
    }, 900_000);

    it("keeps P from S's guest and S's organization member", async () => {
      const { C, D, P, S } = world;
      const callers: Caller[] = [
        {
          name: "D (guest) on S, P ids",
          cookie: D.cookie,
          spaceId: S.spaceId,
          target: P,
          own: S,
          expect: "no-canary",
          knowsOwner: true,
        },
        {
          name: "C (org member) on S, P ids",
          cookie: C.cookie,
          spaceId: S.spaceId,
          target: P,
          own: S,
          expect: "no-canary",
          knowsOwner: true,
        },
      ];
      // P's rows only: C is a member of A's organization by design, so a Space C makes from S
      // lands in that organization and is C's own, not P's.
      const scope = { ...scopeOf(P), organizationIds: [P.ids.soloOrganizationId!] };
      const records = world.records!;
      expect(await waitingRunKept(world, [C.cookie, D.cookie], P, S.spaceId)).toEqual([]);
      const from = mark(records);
      const before = await snapshot(world.db, scope);
      const outcomes = await sweep(world.app, callers, swept());
      console.log(
        `${prefix} statuses per caller\n${summary(outcomes)}\n${prefix} notable\n${notable(outcomes)}`,
      );
      const after = await snapshot(world.db, scope);
      expect(failures(outcomes)).toEqual([]);
      expect(snapshotDiff(before, after), "rows of P changed").toEqual([]);
      // A guest's new Space goes to the guest's own organization, never into A's.
      expect(
        await world.db.space.count({
          where: { organizationId: P.organizationId, createdByUserId: D.userId },
        }),
      ).toBe(0);
      // What C and D do in S may name S by design; nothing may name what only P holds.
      const shared = new Set(Object.values(S.ids));
      const onlyP = foreignIds(callers[0]!).filter((value) => !shared.has(value));
      expect(
        outgoingReport(records, from, callers, { userId: "-", email: "-" }, onlyP),
        "jobs, notifications or mail naming P",
      ).toEqual([]);
    }, 900_000);

    it("shows S's member and guest only what S shares by design", async () => {
      const { A, C, D, S } = world;
      const callers: Caller[] = [C, D].map((person) => ({
        name: `${person.label} on S, S ids`,
        cookie: person.cookie,
        spaceId: S.spaceId,
        target: S,
        expect: "shared",
        knowsOwner: true,
      }));
      const scope = {
        spaceIds: [S.spaceId],
        organizationIds: [S.organizationId],
        userIds: [A.userId],
      };
      const before = await snapshot(world.db, scope);
      // The caller's own leave is theirs by design, and would end the rest of its sweep.
      const calls: string[] = [];
      // Read before the removals: a member may clear S's chat by design, and the cards with it.
      const callsChecked = async (): Promise<Outcome[]> => {
        // A call rings the owner's own phone: the card shows in the shared chat by design, but a
        // member or guest must not answer, decline or end it for A.
        for (const key of ["callId", "declineCallId", "incomingCallId"] as const) {
          const message = await world.db.message.findUnique({
            where: {
              threadId_clientNonce: {
                threadId: S.ids.threadId!,
                clientNonce: callRequestClientNonce(S.ids[key]!),
              },
            },
            select: { blocks: true },
          });
          const status = /"status":"(\w+)"/.exec(JSON.stringify(message?.blocks ?? null))?.[1];
          if (status !== "ringing") calls.push(`${key}: ${status ?? "gone"}`);
        }
        return [];
      };
      // Removals the rest hang off (a bot, a chat, a group) go last, one at a time, so a member's
      // removal of S's bot does not answer the other destructive calls "not found".
      const procedures = swept().filter((procedure) => procedure.path !== "spaces/members/leave");
      const last = (procedure: Procedure) => OWNER_REMOVES_LAST.includes(procedure.path);
      const outcomes = [
        ...(await sweep(
          world.app,
          callers,
          procedures.filter((procedure) => !last(procedure)),
        )),
        ...(await callsChecked()),
        ...(await sweep(
          world.app,
          callers,
          procedures
            .filter(last)
            .sort(
              (a, b) => OWNER_REMOVES_LAST.indexOf(a.path) - OWNER_REMOVES_LAST.indexOf(b.path),
            ),
          { concurrency: 1 },
        )),
      ];
      const after = await snapshot(world.db, scope);
      const seen = new Map<string, Set<string>>();
      for (const outcome of outcomes)
        for (const value of outcome.matched) {
          const kinds = seen.get(outcome.path) ?? new Set<string>();
          kinds.add(kindOf(S, value));
          seen.set(outcome.path, kinds);
        }
      console.log(
        `${prefix} S canaries a member or guest sees, by procedure\n${[...seen]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([procedure, kinds]) => `${procedure}: ${[...kinds].sort().join(" ")}`)
          .join("\n")}`,
      );
      // What C or D added as their own (a Space C makes in the organization it is a member of, a
      // token of C's own) is theirs by design; any other change to these tables is not.
      const admin: string[] = [];
      for (const [table, rows] of after) {
        if (!ADMIN_TABLES.test(table)) continue;
        const old = before.get(table) ?? new Map<string, string>();
        for (const [key, text] of rows) {
          if (!old.has(key)) {
            if (![C.userId, D.userId].some((id) => text.includes(id)))
              admin.push(`${table}: added ${text.slice(0, 300)}`);
          } else if (old.get(key) !== text) admin.push(`${table}: changed ${text.slice(0, 300)}`);
        }
        for (const key of old.keys())
          if (!rows.has(key)) admin.push(`${table}: removed ${old.get(key)!.slice(0, 300)}`);
      }
      console.log(
        `${prefix} call procedures as a member or guest of S\n${outcomes
          .filter((outcome) => /Call$/.test(outcome.path))
          .map((outcome) => `${outcome.caller.name}: ${line(outcome)}`)
          .join("\n")}`,
      );
      expect(failures(outcomes)).toEqual([]);
      expect(admin, "a member or guest changed who is in S, or A's keys").toEqual([]);
      expect(calls, "the owner's ringing calls in S, settled by a member or guest").toEqual([]);
      expect(
        await world.db.spaceMember.count({ where: { spaceId: S.spaceId, userId: A.userId } }),
      ).toBe(1);
    }, 900_000);

    // Last, because the owner's own calls change P: the same sweep run by A finds P's canaries, so
    // the callers above found none because none reached them, not because the scan cannot see.
    it("finds P's canaries when its owner makes the same calls", async () => {
      const { A, P } = world;
      const owner: Caller = {
        name: "A on P (control)",
        cookie: A.cookie,
        spaceId: P.spaceId,
        target: P,
        expect: "no-canary",
        knowsOwner: true,
      };
      // The owner's computer starts and stops in the background: a call to it waits until it is
      // not halfway, so whether it gets through does not depend on timing.
      const computerState = async () =>
        (
          await world.db.bot.findUnique({
            where: { id: P.ids.botId! },
            select: { computer: { select: { state: true } } },
          })
        )?.computer?.state ?? "";
      // Typing, uploading and a terminal need the person to hold the computer, as in the app.
      const needsControl = [
        "computer/input",
        "computer/uploadFile",
        "computer/terminalUrl",
        "dozoTeach/keys",
      ];
      const settle = async (call: Call) => {
        if (!call.path.startsWith("computer/") && !needsControl.includes(call.path)) return;
        const steady = async () => {
          const state = await computerState();
          if (["booting", "suspending"].includes(state)) throw new Error(`computer ${state}`);
          return state;
        };
        const state = await vi.waitFor(steady, { timeout: 15_000, interval: 50 });
        // A computer call that is not a stop works on a running computer, as a person's does:
        // one the owner's sweep let fall asleep is started first (not part of the sweep).
        if (isDestructive(call.path)) return;
        if (state !== "running") {
          await readAnswer(world.app, A.cookie, "computer/boot", { botId: P.ids.botId }, P.spaceId);
          await vi.waitFor(
            async () => {
              if ((await steady()) !== "running") throw new Error("computer not running");
            },
            { timeout: 15_000, interval: 50 },
          );
        }
        if (needsControl.includes(call.path))
          await readAnswer(
            world.app,
            A.cookie,
            "computer/takeover",
            { botId: P.ids.botId },
            P.spaceId,
          );
      };
      const firstOf = (procedure: Procedure) => Number(OWNER_WRITES_FIRST.has(procedure.path));
      // Reads before the owner's own writes (an update renames, a new version replaces), so what is
      // planted is still there when it is read.
      const kept = swept().filter((procedure) => !isDestructive(procedure.path));
      const isRead = (procedure: Procedure) => READ.test(procedure.path.split("/").pop() ?? "");
      // The live recording holds the bot: the calls that act on it go first, then the owner stops
      // it, as the app does, and the rest of the bot's calls stop answering "stop teaching first".
      const teaching = (procedure: Procedure) =>
        OWNER_WRITES_FIRST.has(procedure.path) ||
        procedure.path === "skills/start" ||
        namesKey(procedure, P, "taughtSkillId") ||
        namesKey(procedure, P, "leaseId");
      const writes = kept.filter((procedure) => !isRead(procedure));
      // Taking control comes before the computer calls that need it (typing, a terminal).
      const computerFirst = (procedure: Procedure) =>
        procedure.path === "computer/takeover" ? 0 : procedure.path.startsWith("computer/") ? 1 : 2;
      // The owner's own `skills/start` began another recording: end it too, as a person does
      // before the chat takes messages again. Not part of the sweep, so it returns no outcomes.
      const stopRecordings = async (): Promise<Outcome[]> => {
        for (const skill of await world.db.taughtSkill.findMany({
          where: { botId: P.ids.botId!, status: "recording" },
          select: { id: true },
        }))
          await readAnswer(world.app, A.cookie, "skills/stop", { skillId: skill.id }, P.spaceId);
        return [];
      };
      const stop = swept().filter((procedure) => procedure.path === "skills/stop");
      const outcomes = [
        ...(await sweep(world.app, [owner], kept.filter(isRead))),
        ...(await sweep(
          world.app,
          [owner],
          writes.filter(teaching).sort((a, b) => firstOf(b) - firstOf(a)),
          { concurrency: 1, settle },
        )),
        ...(await sweep(world.app, [owner], stop, { concurrency: 1, settle })),
        ...(await stopRecordings()),
        ...(await sweep(
          world.app,
          [owner],
          writes
            .filter((procedure) => !teaching(procedure))
            .sort((a, b) => computerFirst(a) - computerFirst(b)),
          { concurrency: 1, settle },
        )),
      ];
      const found = [
        ...new Set(
          outcomes.filter((outcome) => outcome.matched.length).map((outcome) => outcome.path),
        ),
      ].sort();
      console.log(
        `${prefix} control: canaries found through ${found.length} procedures\n${found.join(" ")}`,
      );
      const seen = new Set(outcomes.flatMap((outcome) => outcome.matched));
      const unseen = P.canaries.filter((value) => !seen.has(value));
      console.log(`${prefix} control: canaries no owner read shows: ${unseen.join(" ") || "none"}`);
      // Destructive procedures that name P's things after that, one at a time, the removals the
      // rest hang off last; the waiting work made fresh first, as the app may have started it.
      await seedWaitingRun(world.db, A, P);
      const order = (procedure: Procedure) => OWNER_REMOVES_LAST.indexOf(procedure.path);
      outcomes.push(
        ...(await sweep(
          world.app,
          [owner],
          swept()
            .filter(
              (procedure) =>
                isDestructive(procedure.path) &&
                procedure.path !== "skills/stop" &&
                namesTarget(procedure, P),
            )
            .sort((a, b) => order(a) - order(b)),
          { concurrency: 1, settle },
        )),
      );
      const { unreached, stale, reached } = reachReport(outcomes);
      console.log(
        `${prefix} control: owner calls not reached, exempted\n${outcomes
          .filter((outcome) => outcome.foreign && !reaches(outcome))
          .map(line)
          .join("\n")}`,
      );
      const naming = new Set(
        outcomes.filter((outcome) => outcome.foreign).map((outcome) => outcome.path),
      );
      console.log(
        `${prefix} control: procedures naming P ${naming.size}, owner-reached ${reached.size}, not reached ${naming.size - reached.size}`,
      );
      expect(found).toEqual(expect.arrayContaining(CONTROL_PATHS));
      expect(unseen, "canaries no read of the owner shows, so no scan can find them").toEqual([]);
      expect
        .soft(unreached, "inputs naming P's things that the owner's own call does not get through")
        .toEqual([]);
      expect.soft(stale, "stale unreached or reached-409 exemptions").toEqual([]);
    }, 900_000);
  },
);
