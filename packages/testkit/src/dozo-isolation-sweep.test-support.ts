// The isolation matrix's sweep: every call a caller makes with inputs that name a target's things,
// what each answer carried, and the reports that turn an answer into a leak (a canary, an id the
// caller was not sent, a refusal that tells an existing foreign id from a missing one, work the
// app did for the target).
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { IsolationApp, IsolationWorld, Target } from "./dozo-isolation.test-support.js";
import { confirmIdentity, findCanaries, readAnswer } from "./dozo-isolation.test-support.js";
import type { IsolationExemption } from "./dozo-isolation-exemptions.js";
import {
  DESIGNED_SHARING,
  ISOLATION_EXEMPTIONS,
  NEVER_SHARED_KINDS,
  sharedSometimes,
} from "./dozo-isolation-exemptions.js";
import type { Procedure, Resolve } from "./dozo-isolation-inputs.test-support.js";
import { generateInputs, mixedVariants, withOwn } from "./dozo-isolation-inputs.test-support.js";
import { releaseWaitingRun, seedWaitingRun } from "./dozo-isolation-seed.test-support.js";

const CONCURRENCY = 8;
/** Only this answers without a session. */
const PUBLIC_PATHS = new Set(["health"]);

const DESTRUCTIVE =
  /^(remove|delete|archive|revoke|clear|leave|cancel|disconnect|unlink|reset|signOut|end|unregister|unban|ban|setSuspended|dismiss|decline|stop|unpin)/i;

export function isDestructive(path: string) {
  return DESTRUCTIVE.test(path.split("/").pop() ?? "");
}

// --- The sweep ---------------------------------------------------------------------------------

export type Caller = {
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
export type Call = {
  caller: Caller;
  path: string;
  variant: string;
  input: unknown;
  foreign: boolean;
  /** Compare this answer with the one for the same input with made-up ids. */
  compare?: boolean;
};
/** `detail`: the refusal's code and message, for a status of 400 or more. */
export type Outcome = Call & {
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
export function foreignIds(caller: Caller): string[] {
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

export async function sweep(
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

export const kindOf = (target: Target, value: string) =>
  target.kinds?.[value] ??
  (target.identityCanaries?.includes(value)
    ? value.includes("@")
      ? "owneremail"
      : "ownername"
    : "unknown");

export function failures(outcomes: Outcome[]): string[] {
  const out: string[] = [];
  for (const outcome of outcomes) {
    const { caller } = outcome;
    const where = `${outcome.path} [${outcome.variant}] as ${caller.name}: ${outcome.status}`;
    if (caller.expect === "shared") {
      for (const value of outcome.matched) {
        const kind = kindOf(caller.target, value);
        if (NEVER_SHARED_KINDS.includes(kind))
          out.push(`${where} showed ${kind}, which no member may see (${value})`);
        else if (
          !DESIGNED_SHARING[outcome.path]?.includes(kind) &&
          !sharedSometimes(outcome.path, kind)
        )
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
export function refusalReport(outcomes: Outcome[], exemptions = ISOLATION_EXEMPTIONS) {
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
export function notable(outcomes: Outcome[]) {
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

export function summary(outcomes: Outcome[]) {
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
export function reaches(outcome: Outcome) {
  return outcome.status < 400;
}

export const line = (outcome: Outcome) =>
  `${outcome.path} [${outcome.variant}]: ${outcome.status} ${outcome.detail}`;

/**
 * The owner's calls naming P's things that did not get through and are not exempted, and the
 * `unreached` or `reached-409` exemptions that no longer hold.
 */
export function reachReport(outcomes: Outcome[]) {
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
export function outgoingReport(
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

export const mark = (records: NonNullable<IsolationWorld["records"]>) => ({
  jobs: records.jobs.length,
  notifications: records.notifications.length,
  mail: records.mail.length,
});

/**
 * A fresh waiting run of the target's, which the app's reconciler would start within half a
 * minute: each foreign cookie tries to cancel it at once and it must still be waiting; then its
 * owner cancels it through the same procedure, so it does not run in the middle of a sweep.
 */
export async function waitingRunKept(
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
  await releaseWaitingRun(world.db, target);
  return problems;
}

/** The repository root, where `verifiedByCode` paths start. */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * `file:line "fragment" — filter`: the file exists and holds the fragment exactly once, compared
 * with every run of whitespace as one space, so a fragment may run over several lines. The line
 * only tells a reader where to look: it moves with every merge that touches the file above it.
 * Once and not at least once: a filter whose words repeat in the file (the same lookup in several
 * handlers) would still be found after the one meant was removed, so such a fragment starts at
 * its handler's name.
 */
export function codeReferenceProblem(reference: string | undefined): string | undefined {
  const parsed = reference ? /^(\S+):\d+ "(.+?)" — .+/.exec(reference) : null;
  if (!parsed) return `not of the form file:line "fragment" — filter`;
  const [, file, fragment] = parsed;
  const full = path.join(ROOT, file!);
  if (!existsSync(full)) return `${file} does not exist`;
  const spaced = (text: string) => text.replace(/\s+/g, " ");
  const times = spaced(readFileSync(full, "utf8")).split(spaced(fragment!)).length - 1;
  if (times !== 1) return `${file} holds "${fragment}" ${times} times, not once`;
  return undefined;
}
