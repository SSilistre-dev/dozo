import { vi } from "vitest";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

/** The phone tests' fake phone, run and effects (dozo-phone*.test.ts). */

export const PAIRED = new Date("2026-11-01T00:00:00Z");

export type Answer = (signal: AbortSignal) => AsyncIterable<unknown>;
export const answers = (value: unknown): Answer =>
  async function* () {
    yield value;
  };
export const failing = (error: Error): Answer =>
  async function* () {
    yield* [];
    throw error;
  };

export interface PhoneEffect {
  id: string;
  runId: string;
  kind: string;
  status: string;
  request?: unknown;
}

/**
 * A run of the phone's owner, a fake phone answering its requests, and effects in memory. By
 * default the bot already read `tool` once (its consent) and the phone declares every capability.
 */
export function setup(options: {
  owner?: string | undefined;
  phone?: boolean;
  capabilities?: string[];
  token?: boolean;
  consent?: boolean;
  tool?: string;
  answer: Answer;
  tainted?: boolean;
  thread?: Record<string, unknown>;
  otherMember?: boolean;
}) {
  const effects: PhoneEffect[] = [];
  if (options.consent !== false)
    effects.push({
      id: "old",
      runId: "run-0",
      kind: options.tool ?? PHONE_CALENDAR_READ_TOOL,
      status: "completed",
    });
  const requests: Array<{ owner: string; request: Record<string, unknown>; deviceId?: string }> =
    [];
  const declared = options.capabilities ?? ["calendar", "contacts", "location"];
  const devices = {
    connected: vi.fn(async () => null),
    pairedSince: vi.fn(async () => null),
    connectedPhone: vi.fn(async (_owner: string, capability: string) =>
      options.phone === false || !declared.includes(capability)
        ? null
        : { deviceId: "phone-1", pairedAt: PAIRED, onSince: PAIRED },
    ),
    request: vi.fn(
      (owner: string, request: Record<string, unknown>, signal: AbortSignal, deviceId?: string) => {
        requests.push({ owner, request, deviceId });
        return options.answer(signal);
      },
    ),
  };
  type Clause = {
    runId?: string;
    status?: string | { in: string[] };
    request?: { equals: unknown };
  };
  const holds = (effect: PhoneEffect, clause: Clause) =>
    (!clause.runId || effect.runId === clause.runId) &&
    (!clause.request || JSON.stringify(effect.request) === JSON.stringify(clause.request.equals)) &&
    (clause.status === undefined ||
      (typeof clause.status === "string"
        ? effect.status === clause.status
        : clause.status.in.includes(effect.status)));
  const findFirst = vi.fn(
    async ({ where }: { where: Clause & { kind: string | { in: string[] }; OR?: Clause[] } }) =>
      effects.find(
        (effect) =>
          (typeof where.kind === "string"
            ? effect.kind === where.kind
            : where.kind.in.includes(effect.kind)) &&
          holds(effect, where) &&
          (!where.OR || where.OR.some((clause) => holds(effect, clause))),
      ) ?? null,
  );
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const count = vi.fn(
    async ({ where }: { where: Clause & { kind: string } }) =>
      effects.filter((effect) => effect.kind === where.kind && holds(effect, where)).length,
  );
  const prisma = {
    $queryRaw: async () => [{ sourced: Boolean(options.token) }],
    externalEffect: { findFirst, updateMany, count },
    attempt: { count: async () => 1 },
    spaceMember: {
      findFirst: vi.fn(async () => (options.otherMember ? { id: "member-2" } : null)),
    },
  };
  const ctx = {
    source: { userComputerOwner: "owner" in options ? options.owner : "user-1" },
    deps: { userDevices: devices, prisma },
    bot: { id: "bot-1", name: "Ada" },
    run: { id: "run-1", botId: "bot-1", userId: "user-1", spaceId: "space-1", threadId: "t" },
    runId: "run-1",
    thread: { id: "t", spaceId: "space-1", groupId: null, ...options.thread },
    context: { signal: new AbortController().signal },
    secrets: [],
    state: { tainted: Boolean(options.tainted) },
    trust: { receivedOutsideMessage: async () => false },
  } as unknown as RunContext;
  return { ctx, devices, requests, effects, findFirst, updateMany, prisma };
}

/** A call as the executor hands it to a handler, recording what it keeps and finishes with. */
export function call(name: string, args: Record<string, unknown>, claimed = false) {
  const persisted: unknown[] = [];
  const finished: unknown[] = [];
  const toolCall = {
    name,
    args,
    applied: { effect: { id: "effect-1" } },
    claimedEffect: claimed,
    persistEffectResult: vi.fn(async (result: unknown) => {
      persisted.push(result);
      return true;
    }),
    finish: vi.fn(async (result: unknown) => {
      persisted.push(result);
      finished.push(result);
      return result;
    }),
  } as unknown as ToolCall;
  return { call: toolCall, persisted, finished };
}
