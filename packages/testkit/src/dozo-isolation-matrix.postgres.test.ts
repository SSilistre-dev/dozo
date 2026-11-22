// Cross-tenant isolation over the whole RPC surface. Every procedure of the contract is called by
// every caller that must not reach P (A's personal Space) or S (A's shared Space), with inputs
// that name P's or S's things; no answer may carry one of their canaries, and nothing P or S
// holds may change. A new procedure is swept by itself: the list is read from the contract.
import { appContract } from "@rakazo/contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { IsolationWorld, PoolKey, Target } from "./dozo-isolation.test-support.js";
import {
  buildIsolationWorld,
  confirmIdentity,
  findCanaries,
  ISOLATION_LOGINS,
  readAnswer,
  snapshot,
  snapshotDiff,
} from "./dozo-isolation.test-support.js";
import { ISOLATION_EXEMPTIONS } from "./dozo-isolation-exemptions.js";

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
};
const ID_BY_NAMESPACE: Record<string, PoolKey> = {
  dozoAccessTokens: "tokenId",
  agentSecrets: "agentSecretId",
  tickets: "ticketId",
  bots: "botId",
  availability: "agentSkillId",
};
const SECRET_NAME_PATHS = new Set([
  "vault/reveal",
  "vault/activity",
  "vault/remove",
  "botSecrets/remove",
]);

function poolKeyFor(procedure: string, field: string): PoolKey | undefined {
  const namespace = procedure.split("/")[0]!;
  if (field === "id") return ID_BY_NAMESPACE[namespace];
  if (field === "skillId")
    return namespace === "agentSkills" || namespace === "dozoOrganizationLibrary"
      ? "agentSkillId"
      : "taughtSkillId";
  if (field === "name" && SECRET_NAME_PATHS.has(procedure)) return "secretName";
  return FIELD_KEYS[field];
}

const FAIL = Symbol("cannot generate");
const OMIT = Symbol("omit");
type Filled = unknown | typeof FAIL | typeof OMIT;

const STRINGS = [
  "iso-probe",
  "x",
  "https://example.test/",
  "2026-01-01T00:00:00.000Z",
  "probe@example.test",
  "0 9 * * 1",
  "UTC",
  "00000000-0000-4000-8000-000000000000",
  "a".repeat(32),
  "a".repeat(64),
  "AGENTS.md",
];
const NUMBERS = [1, 0, 60, 100, 1000, 100_000, -1];

type Resolve = (key: PoolKey) => string | undefined;
/** Inputs tried per procedure and target, before the mixed ones. */
const MAX_VARIANTS = 4;

class Generator {
  used = new Set<PoolKey>();
  constructor(
    private readonly procedure: string,
    private readonly resolve: Resolve,
    /** Fills optional fields too, for an input whose refinement wants one of them. */
    private readonly fillAll = false,
  ) {}

  private id(field: string | undefined): string | undefined {
    if (!field) return undefined;
    const key = poolKeyFor(this.procedure, field);
    const value = key ? this.resolve(key) : undefined;
    if (key && value) this.used.add(key);
    return value;
  }

  fill(schema: ZodLike, field?: string): Filled {
    const def = schema._zod.def;
    const inner = (name: string) => def[name] as ZodLike;
    switch (def.type) {
      case "optional":
      case "default":
      case "prefault":
        // Left out unless it names something: an optional id is where a foreign id goes.
        if (field === undefined) return this.fill(inner("innerType"), field);
        if (this.fillAll || poolKeyFor(this.procedure, field)) {
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
        for (const value of id ? [id, ...STRINGS] : STRINGS)
          if (schema.safeParse(value).success) return value;
        return FAIL;
      }
      case "number":
      case "int":
        return NUMBERS.find((value) => schema.safeParse(value).success) ?? FAIL;
      case "boolean":
        return false;
      case "literal":
        return (def.values as unknown[])[0];
      case "enum":
        return Object.values(def.entries as Record<string, unknown>)[0];
      case "array": {
        const id = this.id(field);
        if (id && schema.safeParse([id]).success) return [id];
        // A group names at least two bots: the target's second bot goes with the first.
        const second =
          id && field && poolKeyFor(this.procedure, field) === "botId"
            ? this.resolve("secondBotId")
            : undefined;
        if (id && second && schema.safeParse([id, second]).success) return [id, second];
        const element = this.fill(inner("element"));
        const one = element !== FAIL && schema.safeParse([element]).success;
        if (one && this.fillAll) return [element];
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
        : false;
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

type Variant = { label: string; input: unknown; keys: Set<PoolKey> };

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
    const input = make(generator);
    if (input === FAIL || input === OMIT || !schema.safeParse(input).success) return;
    const seen = JSON.stringify(input);
    if (variants.some((variant) => JSON.stringify(variant.input) === seen)) return;
    // Only what the input still names: a choice of one optional id drops the others.
    const keys = new Set(
      [...generator.used].filter((key) => seen.includes(JSON.stringify(resolve(key)))),
    );
    variants.push({ label, input, keys });
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
  /** `refused`: every protected call must answer 401 at membership. */
  expect: "refused" | "no-canary";
};

/** `foreign`: the input names at least one of the target's things. */
type Call = { caller: Caller; path: string; variant: string; input: unknown; foreign: boolean };
type Outcome = Call & { status: number; matched: string[]; streamed: boolean };

async function pool<T, R>(items: T[], run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
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
    for (const variant of variants) {
      const base = { caller, path: procedure.path, variant: variant.label, input: variant.input };
      calls.push({ ...base, foreign: variant.keys.size > 0 });
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

async function sweep(
  world: IsolationWorld,
  callers: Caller[],
  procedures: Procedure[],
  ownToo = false,
) {
  for (const caller of callers) if (caller.cookie) await confirmIdentity(world.app, caller.cookie);
  const reads = procedures.filter((procedure) => !isDestructive(procedure.path));
  const destructive = procedures.filter((procedure) => isDestructive(procedure.path));
  const outcomes: Outcome[] = [];
  // Reads and writes first, destructive procedures after, so a foreign delete that worked still
  // shows in the snapshot instead of hiding the rows the reads would have leaked.
  for (const phase of [reads, destructive]) {
    const calls = callers.flatMap((caller) => callsFor(caller, phase, ownToo));
    outcomes.push(
      ...(await pool(calls, async (call) => {
        const answer = await readAnswer(
          world.app,
          call.caller.cookie,
          call.path,
          call.input,
          call.caller.spaceId,
        );
        return {
          ...call,
          status: answer.status,
          streamed: answer.streamed,
          matched: findCanaries(answer.text, call.caller.target.canaries),
        };
      })),
    );
  }
  return outcomes;
}

function failures(outcomes: Outcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    const where = `${outcome.path} [${outcome.variant}] as ${outcome.caller.name}: ${outcome.status}`;
    if (outcome.matched.length) out.push(`${where} leaked ${outcome.matched.join(", ")}`);
    else if (
      outcome.caller.expect === "refused" &&
      !PUBLIC_PATHS.has(outcome.path) &&
      outcome.status !== 401
    )
      out.push(`${where} was not refused at membership`);
  }
  return out;
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
 * The app's database login for one pass. The runtime login enforces row-level security; the
 * owner login bypasses it (RLS is enabled, not forced), as an install that connects the app as
 * the table owner does, so that pass proves the app's own filters without the database's.
 */

describeWithDatabase.each(ISOLATION_LOGINS)(
  "cross-tenant isolation over every RPC procedure ($name)",
  (login) => {
    let world: IsolationWorld;
    const procedures = contractProcedures();
    const exempt = new Map(ISOLATION_EXEMPTIONS.map((item) => [item.path, item]));
    const swept = () => procedures.filter((procedure) => !exempt.has(procedure.path));
    const scopeOf = (...targets: Target[]) => ({
      spaceIds: targets.map((target) => target.spaceId),
      organizationIds: [...new Set(targets.map((target) => target.organizationId))],
      userIds: [world.A.userId],
    });

    beforeAll(async () => {
      world = await buildIsolationWorld(login.url());
    }, 180_000);

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
      console.log(`[isolation] seed notes:\n${[...P.notes, ...S.notes].join("\n")}`);
    });

    it("reads every procedure from the contract and can call each one not exempted", () => {
      const paths = new Set(procedures.map((procedure) => procedure.path));
      expect(procedures.length).toBeGreaterThan(300);
      const ids = world.P.ids;
      const missing: string[] = [];
      const stale: string[] = [];
      for (const procedure of procedures) {
        const inputs = generateInputs(procedure, (key) => ids[key]);
        const exemption = exempt.get(procedure.path);
        if (!exemption && !inputs) missing.push(procedure.path);
        if (exemption?.kind === "input" && inputs)
          stale.push(`${procedure.path}: input can be generated now`);
        if (exemption?.kind === "side-effect" && inputs?.some((variant) => variant.keys.size > 0))
          stale.push(`${procedure.path}: names a target, so it must be swept`);
      }
      for (const exemption of ISOLATION_EXEMPTIONS)
        if (!paths.has(exemption.path)) stale.push(`${exemption.path}: no such procedure`);
      expect(missing, "procedures with no generated input and no exemption").toEqual([]);
      expect(stale, "stale exemptions").toEqual([]);
      console.log(
        `[isolation] ${procedures.length} procedures, ${swept().length} swept, ${ISOLATION_EXEMPTIONS.length} exempted`,
      );
    });

    it("keeps P and S from B, a removed member, anonymous callers and foreign Space headers", async () => {
      const { A, B, C, E, P, S, Bown } = world;
      const callers: Caller[] = [
        {
          name: "B on own Space, P ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: P,
          own: Bown,
          expect: "no-canary",
        },
        {
          name: "B on own Space, S ids",
          cookie: B.cookie,
          spaceId: B.spaceId,
          target: S,
          own: Bown,
          expect: "no-canary",
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
          name: "C with P's header",
          cookie: C.cookie,
          spaceId: P.spaceId,
          target: P,
          expect: "refused",
        },
      ];
      const before = await snapshot(world.db, scopeOf(P, S));
      const outcomes = await sweep(world, callers, swept());
      console.log(
        `[isolation] statuses per caller\n${summary(outcomes)}\n[isolation] notable\n${notable(outcomes)}`,
      );
      // The read pass again, after every write: what B's mixed writes left in B's own world must not
      // bring P's or S's canaries back with it.
      const again = await sweep(
        world,
        callers.slice(0, 2),
        swept().filter((procedure) => !isDestructive(procedure.path)),
        true,
      );
      const after = await snapshot(world.db, scopeOf(P, S));
      expect([...failures(outcomes), ...failures(again)]).toEqual([]);
      expect(snapshotDiff(before, after), `rows of P or S changed (A is ${A.userId})`).toEqual([]);
    }, 600_000);

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
        },
        {
          name: "C (org member) on S, P ids",
          cookie: C.cookie,
          spaceId: S.spaceId,
          target: P,
          own: S,
          expect: "no-canary",
        },
      ];
      // P's rows only: C is a member of A's organization by design, so a Space C makes from S
      // lands in that organization and is C's own, not P's.
      const scope = { ...scopeOf(P), organizationIds: [] };
      const before = await snapshot(world.db, scope);
      const outcomes = await sweep(world, callers, swept());
      console.log(
        `[isolation] statuses per caller\n${summary(outcomes)}\n[isolation] notable\n${notable(outcomes)}`,
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
    }, 600_000);

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
      };
      // Reads before the owner's own writes (an update renames, a new version replaces), so what is
      // planted is still there when it is read.
      const kept = swept().filter((procedure) => !isDestructive(procedure.path));
      const isRead = (procedure: Procedure) => READ.test(procedure.path.split("/").pop() ?? "");
      const outcomes = [
        ...(await sweep(world, [owner], kept.filter(isRead))),
        ...(await sweep(
          world,
          [owner],
          kept.filter((procedure) => !isRead(procedure)),
        )),
      ];
      const found = [
        ...new Set(
          outcomes.filter((outcome) => outcome.matched.length).map((outcome) => outcome.path),
        ),
      ].sort();
      console.log(
        `[isolation] control: canaries found through ${found.length} procedures\n${found.join(" ")}`,
      );
      const seen = new Set(outcomes.flatMap((outcome) => outcome.matched));
      const unseen = P.canaries.filter((value) => !seen.has(value));
      console.log(
        `[isolation] control: canaries no owner read shows: ${unseen.join(" ") || "none"}`,
      );
      expect(found).toEqual(expect.arrayContaining(CONTROL_PATHS));
      expect(unseen, "canaries no read of the owner shows, so no scan can find them").toEqual([]);
    }, 600_000);
  },
);
