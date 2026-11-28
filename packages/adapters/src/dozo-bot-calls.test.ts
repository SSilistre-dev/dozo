import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  request: vi.fn(async () => ({ ok: true, status: "ringing" })),
  tainted: vi.fn(async () => false),
  quiet: vi.fn(async () => [] as Array<{ startMinute: number; endMinute: number; days: number }>),
}));
vi.mock("./calls/call-request.js", () => ({ requestUserCall: fake.request }));
vi.mock("./runs/assembly/run-context.js", () => ({ isRunTainted: fake.tainted }));
vi.mock("./dozo-quiet-hours.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./dozo-quiet-hours.js")>()),
  readDozoQuietHours: fake.quiet,
}));
vi.mock("@rakazo/db", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@rakazo/db")>()),
  runAsSystem: (_why: string, work: () => unknown) => work(),
}));

import { DOZO_BOT_CALLS_PER_DAY } from "@rakazo/contracts";
import {
  botCallsAvailable,
  callGate,
  dozoCallToolFor,
  dozoMayOfferCall,
  dozoRequestUserCall,
  readBotCallPermission,
  writeBotCallPermission,
} from "./dozo-bot-calls.js";

const NOON = new Date("2026-03-04T12:00:00Z");
const ALL_DAYS = 0b1111111;

function context(trigger: string, options: { allowed?: boolean; callsToday?: number } = {}) {
  const prisma = {
    $queryRaw: vi.fn(async () => (options.allowed ? [{ botId: "bot-1" }] : [])),
    user: { findUnique: vi.fn(async () => ({ timezone: "UTC" })) },
    message: { count: vi.fn(async () => options.callsToday ?? 0) },
  };
  return {
    deps: { prisma },
    run: { trigger, userId: "user-1", botId: "bot-1" },
    bot: { id: "bot-1" },
  } as never;
}

const input = { reason: "Server down", opening: "The server is down." };

beforeEach(() => {
  vi.clearAllMocks();
  fake.tainted.mockResolvedValue(false);
  fake.quiet.mockResolvedValue([]);
});

describe("who may start a call", () => {
  it("lets a person's own turn call, a routine only by permission, and never an outside trigger", () => {
    expect(callGate("user")).toBe("person");
    expect(callGate("routine")).toBe("routine");
    expect(callGate("webhook")).toBe("never");
    expect(callGate("bot_message")).toBe("never");
  });
});

describe("call_user from a routine", () => {
  it("rings when the owner allowed it and nothing stands in the way", async () => {
    expect(await dozoRequestUserCall(context("routine", { allowed: true }), input, NOON)).toEqual({
      ok: true,
      status: "ringing",
    });
    expect(fake.request).toHaveBeenCalledOnce();
  });

  it("refuses without the owner's permission", async () => {
    expect(await dozoRequestUserCall(context("routine"), input, NOON)).toHaveProperty("error");
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("refuses a run that outside content has reached", async () => {
    fake.tainted.mockResolvedValue(true);
    expect(await dozoRequestUserCall(context("routine", { allowed: true }), input, NOON)).toEqual(
      { error: expect.stringContaining("outside content") },
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("refuses inside quiet hours", async () => {
    fake.quiet.mockResolvedValue([{ startMinute: 11 * 60, endMinute: 13 * 60, days: ALL_DAYS }]);
    expect(await dozoRequestUserCall(context("routine", { allowed: true }), input, NOON)).toEqual(
      { error: expect.stringContaining("quiet hours") },
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("refuses past the daily cap", async () => {
    const ctx = context("routine", { allowed: true, callsToday: DOZO_BOT_CALLS_PER_DAY });
    expect(await dozoRequestUserCall(ctx, input, NOON)).toEqual({
      error: expect.stringContaining("Leave a message"),
    });
    expect(fake.request).not.toHaveBeenCalled();
  });
});

describe("call_user elsewhere", () => {
  it("never rings from a webhook, permission or not", async () => {
    expect(await dozoRequestUserCall(context("webhook", { allowed: true }), input, NOON)).toHaveProperty(
      "error",
    );
    expect(fake.request).not.toHaveBeenCalled();
  });

  it("leaves a person's own turn as it was: no permission, quiet hours or cap", async () => {
    fake.quiet.mockResolvedValue([{ startMinute: 0, endMinute: 1439, days: ALL_DAYS }]);
    await dozoRequestUserCall(context("user", { callsToday: 99 }), input, NOON);
    expect(fake.request).toHaveBeenCalledOnce();
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

describe("whether a call is offered and possible", () => {
  it("offers call_user to a person's turn, to a routine by permission, and to a webhook never", async () => {
    const ctx = (trigger: string, allowed: boolean) => context(trigger, { allowed }) as never;
    const offered = (trigger: string, allowed: boolean) => {
      const { deps, run, bot } = ctx(trigger, allowed) as never as {
        deps: never;
        run: never;
        bot: never;
      };
      return dozoMayOfferCall(deps, run, bot);
    };
    expect(await offered("user", false)).toBe(true);
    expect(await offered("routine", false)).toBe(false);
    expect(await offered("routine", true)).toBe(true);
    expect(await offered("webhook", true)).toBe(false);
  });

  it("is available only with calls on and a voice connected", async () => {
    const voice = (found: boolean) => ({
      userVoiceCredential: { findFirst: vi.fn(async () => (found ? { id: "v" } : null)) },
    });
    const available = (on: boolean, found: boolean) =>
      botCallsAvailable({ prisma: voice(found) as never, phoneCallsEnabled: on }, "user-1");
    expect(await available(false, true)).toBe(false);
    expect(await available(true, false)).toBe(false);
    expect(await available(true, true)).toBe(true);
  });
});

describe("the stored permission", () => {
  const db = () => ({
    $queryRaw: vi.fn(async () => [{ botId: "bot-1" }]),
    $executeRaw: vi.fn(async (_strings: TemplateStringsArray) => 1),
  });
  const mine = { userId: "user-1", botId: "bot-1", spaceId: "space-1" };

  it("reads a row as allowed", async () => {
    expect(await readBotCallPermission(db() as never, "user-1", "bot-1")).toBe(true);
  });

  it("writes a row to allow and deletes it to forbid", async () => {
    const allow = db();
    await writeBotCallPermission(allow as never, { ...mine, allowed: true });
    expect(allow.$executeRaw.mock.calls[0]?.[0]?.join("?")).toContain("INSERT INTO dozo_bot_calls");
    const forbid = db();
    await writeBotCallPermission(forbid as never, { ...mine, allowed: false });
    expect(forbid.$executeRaw.mock.calls[0]?.[0]?.join("?")).toContain("DELETE FROM dozo_bot_calls");
  });
});
