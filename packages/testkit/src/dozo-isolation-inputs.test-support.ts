// The isolation matrix's inputs: every procedure of the contract, and for each one valid inputs
// that name a target's things, read from its input schema. A new procedure gets inputs by itself.
import { appContract } from "@rakazo/contracts";
import type { PoolKey, Target } from "./dozo-isolation.test-support.js";

// --- Enumeration -------------------------------------------------------------------------------

type ZodLike = {
  _zod: { def: Record<string, unknown> & { type: string } };
  safeParse(value: unknown): { success: boolean };
};
export type Procedure = { path: string; input: ZodLike | undefined };

export function contractProcedures(): Procedure[] {
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
  invitationId: "invitationId",
  grantId: "pageGrantId",
  commentId: "pageCommentId",
  organizationConnectionId: "organizationConnectionId",
};
/** Fields that name another kind of thing in one procedure than everywhere else. */
const PATH_FIELD_KEYS: Record<string, Record<string, PoolKey>> = {
  "threads/declineCall": { callId: "declineCallId" },
  "notifications/declineIncomingCall": { callId: "incomingCallId" },
  // Not the canary's own document: a member's edit replaces its content, and the read that shows
  // the canary would then depend on running before it.
  "memory/update": { documentId: "removableDocumentId" },
  "memory/remove": { documentId: "removableDocumentId" },
  "organizations/rename": { organizationId: "soloOrganizationId" },
  "organizations/remove": { organizationId: "soloOrganizationId" },
  "dozoQueue/cancelWaiting": { runId: "waitingRunId", messageId: "waitingMessageId" },
  "dozoLearning/undo": { changeId: "learningChangeId" },
  "computer/readFile": { path: "filePath" },
  "computer/downloadFile": { path: "filePath" },
  // The target's paired computer, which runs an agent: another person's is refused.
  "dozoCliAccounts/connect": { deviceId: "deviceId" },
  "connections/complete": { connectionId: "connectionId" },
  "connections/rename": { connectionId: "connectionId" },
  "connections/revoke": { connectionId: "connectionId" },
  // Its own invitation: the owner's cancel would otherwise end the one the later calls name.
  "organizations/invitations/cancel": { invitationId: "cancelInvitationId" },
  "meetings/shareTranscript": { id: "shareMeetingId" },
  "meetings/deleteTranscript": { id: "deleteMeetingId" },
  // The target's model connection, which the person's voice may use.
  "voice/connect": { modelCredentialId: "credentialId" },
  "messaging/connections/respond": { connectionId: "messagingConnectionId" },
  "messaging/connections/revoke": { connectionId: "messagingConnectionId" },
  "messaging/installations/remove": { id: "messagingInstallationId" },
  "computer/dismissUpdate": { id: "computerUpdateId" },
  "dozoAdmin/stopComputer": { computerId: "computerId" },
  // A mention chip names a bot (the first kind of chip).
  "threads/send": { id: "botId" },
  "threads/sendWithRoutines": { id: "botId" },
  // The organization's own app connection, model connection and shared logins.
  "connections/reconnectOrganization": { connectionId: "organizationConnectionId" },
  "models/organizationConnections/select": { id: "organizationModelConnectionId" },
  "models/organizationConnections/remove": { id: "organizationModelConnectionId" },
  "organizations/vault/signIn": { loginId: "organizationLoginId" },
  "organizations/vault/revokeSession": { loginId: "organizationLoginId" },
  "organizations/vault/setAgents": { loginId: "organizationLoginId" },
  "organizations/vault/remove": { loginId: "organizationLoginId" },
};
/** Values a procedure's own field needs, where the plain string of the generic ones is refused. */
const PATH_FIELD_VALUES: Record<string, Record<string, string>> = {
  // An agent a paired computer can run, so the owner's own call connects it.
  "dozoCliAccounts/connect": { provider: "codex-agent" },
};
/** A field whose name says it names something; each one must be filled from the target's things. */
const ID_FIELD = /Id$|Ids$|^id$/;
const ID_BY_NAMESPACE: Record<string, PoolKey> = {
  apiKeys: "apiKeyId",
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
  meetings: "meetingId",
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

export type Resolve = (key: PoolKey) => string | undefined;
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
export function idFields(
  schema: ZodLike | undefined,
  out = new Set<string>(),
  seen = new Set<unknown>(),
) {
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
        const pathHint =
          field === undefined ? undefined : PATH_FIELD_VALUES[this.procedure]?.[field];
        for (const value of [
          id,
          pathHint,
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
export function generateInputs(procedure: Procedure, resolve: Resolve): Variant[] | null {
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
export function withOwn(input: unknown, target: Target, own: Target, kinds: Set<PoolKey>): unknown {
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
export function mixedVariants(base: Variant, target: Target, own: Target): Variant[] {
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

/** Whether some generated input for `procedure` names one of `target`'s things. */
export function namesTarget(procedure: Procedure, target: Target) {
  return (generateInputs(procedure, (key) => target.ids[key]) ?? []).some(
    (variant) => variant.keys.size > 0,
  );
}

/** Whether some generated input for `procedure` names `target`'s thing of kind `key`. */
export function namesKey(procedure: Procedure, target: Target, key: PoolKey) {
  return (generateInputs(procedure, (wanted) => target.ids[wanted]) ?? []).some((variant) =>
    variant.keys.has(key),
  );
}
