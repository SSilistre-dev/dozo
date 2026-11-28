import { RUN_TRIGGERS } from "@rakazo/contracts";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  request: vi.fn(async (..._args: unknown[]) => ({}) as Record<string, unknown>),
  tokenMarked: vi.fn(async () => false),
  quiet: vi.fn(async () => [] as Array<{ startMinute: number; endMinute: number; days: number }>),
  lock: vi.fn(async () => undefined),
}));
vi.mock("./calls/call-request.js", () => ({ requestUserCall: fake.request }));
vi.mock("./dozo-token-marks.js", () => ({ dozoBotTokenTainted: fake.tokenMarked }));
vi.mock("./locks/advisory-lock.js", () => ({ advisoryLock: fake.lock }));
vi.mock("./dozo-quiet-hours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-quiet-hours.js")>()),
  readDozoQuietHours: fake.quiet,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  runAsSystem: (_why: string, work: () => unknown) => work(),
}));

import { DOZO_BOT_CALLS_PER_DAY } from "@rakazo/contracts";
import type { CallStanding } from "./dozo-bot-calls.js";
import {
  botCallsAvailable,
  callStanding,
  dozoCallToolFor,
  dozoMayOfferCall,
  dozoRequestUserCall,
  readBotCallPermission,
  writeBotCallPermission,
} from "./dozo-bot-calls.js";

const NOON = new Date("2026-03-04T12:00:00Z");
const ALL_DAYS = 0b1111111;

type Stored = {
  routineId?: string | null;
  clientNonce?: string | null;
  source?: { role: string; clientNonce?: string | null } | null;
  steering?: string[];
  allowed?: boolean;
  callsToday?: number;
};

/** A database that answers the questions the policy asks, and records what it was told to write. */
function database(stored: Stored = {}) {
  const writes: string[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    run: {
      findUnique: vi.fn(async () => ({
        routineId: stored.routineId ?? null,
        clientNonce: stored.clientNonce ?? null,
        sourceMessage: stored.source ?? null,
      })),
    },
    steeringMessage: {
      findMany: vi.fn(async () => (stored.steering ?? []).map((originTrigger) => ({ originTrigger }))),
    },
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = sql(strings);
      if (text.includes("FROM dozo_bot_calls")) return stored.allowed ? [{ botId: "bot-1" }] : [];
      if (text.includes("count(*)")) {
        writes.push("count");
        return [{ calls: stored.callsToday ?? 0 }];
      }
      if (text.includes("INSERT INTO dozo_bot_call_log")) {
        writes.push("reserve");
        return [{ id: "slot-1" }];
      }
      return [];
    }),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray) => {
      const text = sql(strings);
      writes.push(text.includes("DELETE FROM dozo_bot_call_log WHERE id") ? "give back" : "prune");
      return 1;
    }),
    $transaction: vi.fn(async (work: (tx: unknown) => unknown) => work(prisma)),
  };
  return { prisma, writes };
}

const runOf = (trigger: string) => ({
  id: "run-1",
  userId: "user-1",
  botId: "bot-1",
  threadId: "thread-1",
  trigger,
});
const person: Stored = { source: { role: "user", clientNonce: "n-1" } };
const routine: Stored = { routineId: "routine-1" };

beforeEach(() => {
  vi.clearAllMocks();
  fake.request.mockResolvedValue({ ok: true, status: "ringing" });
  fake.tokenMarked.mockResolvedValue(false);
  fake.quiet.mockResolvedValue([]);
});

describe("whose turn a run is, for every trigger there is", () => {
  const EXPECTED: Record<(typeof RUN_TRIGGERS)[number], [CallStanding, Stored]> = {
    user: ["person", person],
    reaction: ["person", person],
    follow_up: ["person", person],
    messaging: ["person", person],
    routine: ["routine", routine],
    resume: ["none", person],
    call_end: ["none", person],
    spawn: ["none", person],
    skill: ["none", person],
    bot_message: ["none", person],
    webhook: ["none", person],
    cloud_agent: ["none", person],
    purchase: ["none", person],
    media: ["none", person],
    created: ["none", person],
    tickets: ["none", person],
    helper: ["none", person],
    helper_result: ["none", person],
  };

  it("names every trigger, so a new one has to be decided here", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...RUN_TRIGGERS].sort());
  });

  it.each(Object.entries(EXPECTED))("%s", async (trigger, [standing, stored]) => {
    const { prisma } = database(stored);
    expect(await callStanding(prisma as never, runOf(trigger))).toBe(standing);
  });

  it("offers call_user to a person's turn, to a routine only with permission, and to the rest never", async () => {
    const offered = async (trigger: string, stored: Stored) =>
      dozoMayOfferCall({ prisma: database(stored).prisma as never }, runOf(trigger));
    expect(await offered("user", person)).toBe(true);
    expect(await offered("routine", routine)).toBe(false);
    expect(await offered("routine", { ...routine, allowed: true })).toBe(true);
    for (const trigger of ["spawn", "media", "cloud_agent", "purchase", "helper_result", "skill", "resume"])
      expect(await offered(trigger, { ...person, allowed: true })).toBe(false);
  });
});

describe("what keeps a turn from being the person's own", () => {
  const standing = async (trigger: string, stored: Stored) =>
    callStanding(database(stored).prisma as never, runOf(trigger));

  it("refuses a message sent with an access token, as a turn or a follow-up", async () => {
    const token = { role: "user", clientNonce: "api:key-1" };
    expect(await standing("user", { source: token })).toBe("none");
    expect(await standing("follow_up", { source: token })).toBe("none");
  });

  it("refuses a follow-up a bot queued, or the app's own connection follow-up", async () => {
    expect(await standing("follow_up", { source: { role: "bot" } })).toBe("none");
    expect(await standing("follow_up", { ...person, clientNonce: "app-connected:x" })).toBe("none");
  });

  it("refuses a routine run without a routine, or one of a bot a token marked", async () => {
    expect(await standing("routine", {})).toBe("none");
    fake.tokenMarked.mockResolvedValue(true);
    expect(await standing("routine", routine)).toBe("none");
  });

  it("holds a turn a schedule joined to the routine gate and one a webhook or channel joined to none", async () => {
    expect(await standing("user", { ...person, steering: ["routine"] })).toBe("routine");
    expect(await standing("user", { ...person, steering: ["webhook"] })).toBe("none");
    expect(await standing("user", { ...person, steering: ["messaging"] })).toBe("none");
    expect(await standing("messaging", { ...person, steering: ["messaging"] })).toBe("person");
  });
});

describe("call_user from a routine", () => {
  const ring = (stored: Stored, trigger = "routine", now = NOON) => {
    const db = database(stored);
    const deps = { prisma: db.prisma, phoneCallsEnabled: true };
    return dozoRequestUserCall(deps as never, runOf(trigger) as never, { reason: "r", opening: "o" }, now).then(
      (result) => ({ result, writes: db.writes }),
    );
  };

  it("rings with permission, even when the run read outside content, taking its slot first", async () => {
    const { result, writes } = await ring({ ...routine, allowed: true });
    expect(result).toEqual({ ok: true, status: "ringing" });
    expect(writes).toEqual(["count", "prune", "reserve"]);
    expect(fake.lock).toHaveBeenCalledWith(expect.anything(), "call", "user-1", "joined");
  });

  it("refuses without the owner's permission and takes no slot", async () => {
    const { result, writes } = await ring(routine);
    expect(result).toHaveProperty("error");
    expect(writes).toEqual([]);
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("refuses inside quiet hours", async () => {
    fake.quiet.mockResolvedValue([{ startMinute: 11 * 60, endMinute: 13 * 60, days: ALL_DAYS }]);
    const { result } = await ring({ ...routine, allowed: true });
    expect(result).toEqual({ error: expect.stringContaining("quiet hours") });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("refuses past the daily cap", async () => {
    const { result } = await ring({ ...routine, allowed: true, callsToday: DOZO_BOT_CALLS_PER_DAY });
    expect(result).toEqual({ error: expect.stringContaining("Leave a message") });
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("gives the slot back when the call is refused, say by the cooldown", async () => {
    fake.request.mockResolvedValue({ error: "You already called" });
    const { result, writes } = await ring({ ...routine, allowed: true });
    expect(result).toEqual({ error: "You already called" });
    expect(writes.at(-1)).toBe("give back");
  });

  it("holds a person's turn that a schedule joined to the same limits", async () => {
    expect((await ring({ ...person, steering: ["routine"] }, "user")).result).toHaveProperty("error");
  });
});

describe("call_user in other runs", () => {
  const ring = async (trigger: string, stored: Stored) => {
    const db = database(stored);
    fake.quiet.mockResolvedValue([{ startMinute: 0, endMinute: 1439, days: ALL_DAYS }]);
    const deps = { prisma: db.prisma, phoneCallsEnabled: true };
    const result = await dozoRequestUserCall(deps as never, runOf(trigger) as never, { reason: "r", opening: "o" }, NOON);
    return { result, writes: db.writes };
  };

  it("leaves a person's own turn as it was: no permission, quiet hours, cap or count", async () => {
    const { result, writes } = await ring("user", { ...person, callsToday: 99 });
    expect(result).toEqual({ ok: true, status: "ringing" });
    expect(writes).toEqual([]);
  });

  it("refuses every run that is not the person's or a routine's, permission or not", async () => {
    for (const trigger of ["webhook", "bot_message", "spawn", "media", "cloud_agent", "purchase", "helper_result", "skill", "resume"]) {
      expect((await ring(trigger, { ...person, allowed: true })).result).toEqual({
        error: "Calls are not available in this run.",
      });
    }
    expect(fake.request).not.toHaveBeenCalled();
  });
});

describe("the tool's description", () => {
  const tool = { name: "call_user", description: "Ring the user." };
  it("carries the guidance in a routine's run only", () => {
    expect(dozoCallToolFor("routine")(tool).description).toContain("urgent");
    expect(dozoCallToolFor("user")(tool)).toBe(tool);
    const other = { name: "message_user", description: "x" };
    expect(dozoCallToolFor("routine")(other)).toBe(other);
  });
});

describe("availability and the stored permission", () => {
  const voice = (found: boolean) => ({
    userVoiceCredential: { findFirst: vi.fn(async () => (found ? { id: "v" } : null)) },
  });
  it("is available only with calls on in the deployment's env and a voice connected", async () => {
    const available = (on: boolean | undefined, found: boolean) =>
      botCallsAvailable({ prisma: voice(found) as never, env: { phoneCallsEnabled: on } }, "user-1");
    expect(await available(undefined, true)).toBe(false);
    expect(await available(false, true)).toBe(false);
    expect(await available(true, false)).toBe(false);
    expect(await available(true, true)).toBe(true);
  });

  it("reads a row as allowed, writes one to allow and deletes it to forbid", async () => {
    const { prisma } = database({ allowed: true });
    expect(await readBotCallPermission(prisma as never, "user-1", "bot-1")).toBe(true);
    const mine = { userId: "user-1", botId: "bot-1", spaceId: "space-1" };
    await writeBotCallPermission(prisma as never, { ...mine, allowed: true });
    await writeBotCallPermission(prisma as never, { ...mine, allowed: false });
    const [allow, forbid] = prisma.$executeRaw.mock.calls.map(([strings]) => strings.join("?"));
    expect(allow).toContain("INSERT INTO dozo_bot_calls");
    expect(forbid).toContain("DELETE FROM dozo_bot_calls");
  });
});
