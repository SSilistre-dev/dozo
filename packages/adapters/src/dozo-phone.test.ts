import { deferred } from "@rakazo/core/test-async";
import { afterEach, describe, expect, it, vi } from "vitest";

const logged = vi.hoisted(() => [] as unknown[][]);
vi.mock("@rakazo/logging", async (importOriginal) => {
  const real = await importOriginal<typeof import("@rakazo/logging")>();
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      logged.push([level, ...args]);
  const logger = { warn: record("warn"), error: record("error"), info: record("info") };
  return { ...real, getLogger: () => ({ ...real.getLogger(), ...logger }) };
});

import { withoutCloudComputerTools } from "./dozo-no-computer.js";
import {
  isPhoneTool,
  offerPhoneTools,
  PHONE_ANSWER_MS,
  PHONE_READ_NOTE,
  phoneCalendarRead,
  phoneGate,
  phoneInput,
  phoneRoute,
  runReadPhone,
} from "./dozo-phone.js";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import { phoneCalendarValue } from "./dozo-phone-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { USER_DEVICE_OFFLINE_MESSAGE, UserDeviceOfflineError } from "./user-device-gateway.js";

const PAIRED = new Date("2026-11-01T00:00:00Z");
const SECRET_TITLE = "Dentist with Dr. Example";
const RANGE = { from: "2026-11-22T00:00:00+03:00", to: "2026-11-29T00:00:00+03:00" };
const EVENT = {
  title: SECRET_TITLE,
  start: "2026-11-23T09:00:00+03:00",
  end: "2026-11-23T10:00:00+03:00",
  allDay: false,
  location: "Clinic",
  calendar: "Home",
};

type Answer = (signal: AbortSignal) => AsyncIterable<unknown>;
const answers = (value: unknown): Answer =>
  async function* () {
    yield value;
  };

/** A run of the phone's owner, a fake phone answering its requests, and effects in memory. */
function setup(
  options: {
    owner?: string | undefined;
    phone?: boolean;
    token?: boolean;
    consent?: boolean;
    answer?: Answer;
  } = {},
) {
  const effects: Array<{ id: string; runId: string; kind: string; status: string }> = [];
  if (options.consent !== false)
    effects.push({
      id: "old",
      runId: "run-0",
      kind: PHONE_CALENDAR_READ_TOOL,
      status: "completed",
    });
  const requests: Array<{ owner: string; request: Record<string, unknown>; deviceId?: string }> =
    [];
  const devices = {
    connected: vi.fn(async () => null),
    pairedSince: vi.fn(async () => null),
    connectedPhone: vi.fn(async () =>
      options.phone === false ? null : { deviceId: "phone-1", pairedAt: PAIRED },
    ),
    request: vi.fn(
      (owner: string, request: Record<string, unknown>, signal: AbortSignal, deviceId?: string) => {
        requests.push({ owner, request, deviceId });
        return (options.answer ?? answers({ events: [EVENT], truncated: false }))(signal);
      },
    ),
  };
  type Clause = { runId?: string; status?: string | { in: string[] } };
  const holds = (effect: (typeof effects)[number], clause: Clause) =>
    (!clause.runId || effect.runId === clause.runId) &&
    (clause.status === undefined ||
      (typeof clause.status === "string"
        ? effect.status === clause.status
        : clause.status.in.includes(effect.status)));
  const findFirst = vi.fn(
    async ({ where }: { where: Clause & { kind: string; OR?: Clause[] } }) =>
      effects.find(
        (effect) =>
          effect.kind === where.kind &&
          holds(effect, where) &&
          (!where.OR || where.OR.some((clause) => holds(effect, clause))),
      ) ?? null,
  );
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const prisma = {
    $queryRaw: async () => [{ sourced: Boolean(options.token) }],
    externalEffect: { findFirst, updateMany },
  };
  const ctx = {
    source: { userComputerOwner: "owner" in options ? options.owner : "user-1" },
    deps: { userDevices: devices, prisma },
    bot: { id: "bot-1", name: "Ada" },
    run: { id: "run-1", botId: "bot-1", userId: "user-1", spaceId: "space-1", threadId: "t" },
    runId: "run-1",
    context: { signal: new AbortController().signal },
    secrets: [],
  } as unknown as RunContext;
  return { ctx, devices, requests, effects, findFirst, updateMany };
}

function call(args: Record<string, unknown>, claimed = false) {
  const persisted: unknown[] = [];
  const finished: unknown[] = [];
  const toolCall = {
    name: PHONE_CALENDAR_READ_TOOL,
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

/** The gate, then the handler, as the executor runs a call that passed its approval. */
async function read(run: ReturnType<typeof setup>, args: Record<string, unknown> = { ...RANGE }) {
  const plan = await phoneGate(run.ctx, false, args);
  const made = call(args);
  return { plan, ...made, result: await phoneCalendarRead(run.ctx, made.call) };
}

afterEach(() => {
  logged.length = 0;
  vi.restoreAllMocks();
});

describe("the phone a run reaches", () => {
  it("is the owner's connected phone with Calendar on, in their own run only", async () => {
    const run = setup();
    expect(await phoneRoute(run.ctx)).toMatchObject({ owner: "user-1", deviceId: "phone-1" });
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "calendar");
    expect(await phoneRoute(setup({ owner: undefined }).ctx)).toBeUndefined();
    expect(await phoneRoute(setup({ phone: false }).ctx)).toBeUndefined();
    // A gateway that cannot reach phones (the desktop server's own) has none.
    const plain = setup();
    (plain.ctx.deps as { userDevices: unknown }).userDevices = { connected: async () => null };
    expect(await phoneRoute(plain.ctx)).toBeUndefined();
    expect(isPhoneTool(PHONE_CALENDAR_READ_TOOL)).toBe(true);
    expect(isPhoneTool("user_computer_shell")).toBe(false);
  });

  it("is offered only while the phone is there, the bot keeps it and no token reached the run", async () => {
    const RUN = { botId: "bot-1", threadId: "t" };
    const offered = async (run: ReturnType<typeof setup>, botDisabled: string[] | null = null) => {
      const off = withoutCloudComputerTools(new Set(), false);
      await offerPhoneTools(run.ctx.deps as never, RUN, "user-1", off, botDisabled);
      return !off.has(PHONE_CALENDAR_READ_TOOL);
    };
    expect(withoutCloudComputerTools(new Set(), false).has(PHONE_CALENDAR_READ_TOOL)).toBe(true);
    expect(await offered(setup())).toBe(true);
    expect(await offered(setup(), [PHONE_CALENDAR_READ_TOOL])).toBe(false);
    expect(await offered(setup({ phone: false }))).toBe(false);
    expect(await offered(setup({ token: true }))).toBe(false);
    const failing = setup();
    failing.devices.connectedPhone.mockRejectedValue(new Error("db down"));
    expect(await offered(failing)).toBe(false);
    const plain = setup();
    (plain.ctx.deps as { userDevices?: unknown }).userDevices = undefined;
    expect(await offered(plain)).toBe(false);
  });
});

describe("what a call may ask for", () => {
  it("is a range of ISO times with offsets, at most 31 days, and a short query", () => {
    expect(phoneInput({ ...RANGE, query: "  dentist " })).toEqual({ ...RANGE, query: "dentist" });
    expect(phoneInput({ ...RANGE, query: " " })).toEqual(RANGE);
    expect(phoneInput({ from: "2026-11-22", to: RANGE.to })).toHaveProperty("error");
    expect(phoneInput({ from: "2026-11-22T00:00:00", to: RANGE.to })).toHaveProperty("error");
    expect(phoneInput({ from: RANGE.to, to: RANGE.from })).toEqual({
      error: "to must be after from.",
    });
    expect(phoneInput({ from: "2026-11-01T00:00:00Z", to: "2026-12-02T00:00:01Z" })).toHaveProperty(
      "error",
      expect.stringContaining("31 days"),
    );
    expect(phoneInput({ from: "2026-11-01T00:00:00Z", to: "2026-12-02T00:00:00Z" })).toEqual({
      from: "2026-11-01T00:00:00Z",
      to: "2026-12-02T00:00:00Z",
    });
    expect(phoneInput({ ...RANGE, query: 5 })).toEqual({ error: "query must be text." });
    expect(phoneInput({ ...RANGE, query: "x".repeat(101) })).toHaveProperty("error");
  });

  it("refuses a range over 31 days without asking the phone, and keeps no consent from it", async () => {
    const run = setup({ consent: false });
    const args = { from: "2026-11-01T00:00:00Z", to: "2026-12-15T00:00:00Z" };
    const { plan, result } = await read(run, args);
    expect(plan).toBe("allow");
    expect(result).toHaveProperty("error", expect.stringContaining("31 days"));
    expect(run.requests).toEqual([]);
    expect(run.updateMany).toHaveBeenCalledWith({
      where: { id: "effect-1", status: { in: ["intended", "executing"] } },
      data: { status: "denied", result: { refused: "input" } },
    });
  });
});

describe("a read", () => {
  it("sends the range to the owner's phone by its id and gives the model the events", async () => {
    const run = setup();
    const { plan, result, persisted } = await read(run, { ...RANGE, query: "Dentist" });
    expect(plan).toBe("allow");
    expect(run.requests).toEqual([
      {
        owner: "user-1",
        deviceId: "phone-1",
        request: {
          method: "phoneCalendarRead",
          botId: "bot-1",
          runId: "run-1",
          ...RANGE,
          query: "Dentist",
          limit: 50,
        },
      },
    ]);
    expect(result).toEqual({ events: [EVENT], truncated: false });
    // The effect keeps how many, never what.
    expect(persisted).toEqual([{ events: 1, note: PHONE_READ_NOTE }]);
    expect(JSON.stringify(persisted)).not.toContain(SECRET_TITLE);
    expect(JSON.stringify(logged)).not.toContain(SECRET_TITLE);
  });

  it("caps what the phone sends: 50 events, cut fields, nothing else", async () => {
    const many = Array.from({ length: 60 }, (_, index) => ({
      ...EVENT,
      title: `${"t".repeat(300)}${index}`,
      location: "l".repeat(300),
      calendar: "c".repeat(300),
      notes: "private notes",
      attendees: [{ email: "someone@example.test" }],
      url: "https://example.test/meeting",
      id: "event-id",
    }));
    const run = setup({ answer: answers({ events: many, truncated: false, extra: 1 }) });
    const { result, persisted } = await read(run);
    const { events, truncated } = result as {
      events: Array<Record<string, unknown>>;
      truncated: boolean;
    };
    expect(truncated).toBe(true);
    expect(events).toHaveLength(50);
    expect(Object.keys(events[0]!).sort()).toEqual([
      "allDay",
      "calendar",
      "end",
      "location",
      "start",
      "title",
    ]);
    expect(events[0]).toMatchObject({
      title: "t".repeat(200),
      location: "l".repeat(200),
      calendar: "c".repeat(100),
    });
    expect(JSON.stringify(result)).not.toMatch(/private notes|someone@|meeting|event-id/);
    expect(persisted).toEqual([{ events: 50, note: PHONE_READ_NOTE }]);
  });

  it("drops events it cannot read and refuses an answer that is none", () => {
    expect(
      phoneCalendarValue({
        events: [EVENT, { ...EVENT, start: "soon" }, { title: 1 }, "x"],
        truncated: false,
      }),
    ).toEqual({ events: [EVENT], truncated: false });
    expect(phoneCalendarValue({ events: [], truncated: true })).toEqual({
      events: [],
      truncated: true,
    });
    const bare = phoneCalendarValue({
      events: [{ ...EVENT, location: "", calendar: undefined }],
      truncated: false,
    });
    expect(bare?.events[0]).not.toHaveProperty("location");
    expect(phoneCalendarValue("nope")).toBeNull();
    expect(phoneCalendarValue({ events: "all" })).toBeNull();
  });

  it("tells the model an unreadable answer, logging only that it was", async () => {
    const run = setup({ answer: answers({ events: [EVENT] }) });
    const { result, finished } = await read(run);
    expect(result).toEqual({ error: "The user's phone could not read its calendar." });
    expect(finished).toEqual([result]);
    expect(logged).toEqual([["warn", "phone calendar read failed", { kind: "invalid" }]]);
  });

  it("is uncertain when its count cannot be kept", async () => {
    const run = setup();
    const args = { ...RANGE };
    await phoneGate(run.ctx, false, args);
    const made = call(args);
    vi.mocked(made.call.persistEffectResult).mockResolvedValueOnce(false);
    const result = await phoneCalendarRead(run.ctx, made.call);
    expect(result).toHaveProperty("uncertain", true);
    expect(JSON.stringify(result)).not.toContain(SECRET_TITLE);
  });
});

describe("a read that fails", () => {
  const failing = (error: Error): Answer =>
    async function* () {
      yield* [];
      throw error;
    };

  it.each([
    ["calendar-off", "turn on Calendar"],
    ["calendar-permission", "turn on Calendar"],
    ["calendar-unavailable", "could not read its calendar"],
    ["something else", "could not read its calendar"],
  ])("maps the phone's %s to one sentence, logging only its kind", async (text, says) => {
    const run = setup({ answer: failing(new Error(text)) });
    const { result } = await read(run);
    expect((result as { error: string }).error).toContain(says);
    expect(logged).toEqual([
      ["warn", "phone calendar read failed", { kind: text === "something else" ? "other" : text }],
    ]);
  });

  it("asks the user to open the app when the phone went away", async () => {
    for (const error of [new UserDeviceOfflineError(), new Error(USER_DEVICE_OFFLINE_MESSAGE)]) {
      const run = setup({ answer: failing(error) });
      const { result } = await read(run);
      expect((result as { error: string }).error).toContain("open the app on their phone");
    }
  });

  it("gives up after 20 seconds instead of waiting for the device's ten minutes", async () => {
    const deadline = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
    const asked = deferred<void>();
    const run = setup({
      answer: async function* (signal) {
        asked.resolve();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        yield* [];
      },
    });
    const args = { ...RANGE };
    await phoneGate(run.ctx, false, args);
    const pending = phoneCalendarRead(run.ctx, call(args).call);
    await asked.promise;
    expect(timeout).toHaveBeenCalledWith(PHONE_ANSWER_MS);
    expect(PHONE_ANSWER_MS).toBe(20_000);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    expect(await pending).toEqual({
      error: "The user's phone did not answer in time. Ask them to keep the app open.",
    });
  });

  it("stops with the run when the run is stopped", async () => {
    const stop = new AbortController();
    const asked = deferred<void>();
    const run = setup({
      answer: async function* (signal) {
        asked.resolve();
        await new Promise((_, reject) =>
          signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
        );
        yield* [];
      },
    });
    (run.ctx as { context: { signal: AbortSignal } }).context = { signal: stop.signal };
    const args = { ...RANGE };
    await phoneGate(run.ctx, false, args);
    const pending = phoneCalendarRead(run.ctx, call(args).call);
    await asked.promise;
    stop.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("refuses at execution when the phone left after the run was offered it", async () => {
    const run = setup();
    const args = { ...RANGE };
    expect(await phoneGate(run.ctx, false, args)).toBe("allow");
    run.devices.connectedPhone.mockResolvedValue(null);
    const result = await phoneCalendarRead(run.ctx, call(args).call);
    expect(result).toEqual({
      error:
        "The user's phone is not connected. Ask them to open the app on their phone, then try again.",
    });
    expect(run.requests).toEqual([]);
  });

  it("refuses a call its approval did not see, and one on a phone paired since", async () => {
    const run = setup({ consent: false });
    const args = { ...RANGE };
    // Asked, and run anyway (an approval for an earlier pairing): it reads nothing.
    expect(await phoneGate(run.ctx, false, args)).toBe("ask");
    const asked = call(args, true);
    expect(await phoneCalendarRead(run.ctx, asked.call)).toHaveProperty(
      "error",
      expect.stringContaining("changed"),
    );
    expect(asked.finished).toEqual([]);
    expect(run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "denied", result: { refused: "changed" } } }),
    );
    // Allowed on one phone, then another one connected.
    const moved = setup();
    const kept = { ...RANGE };
    await phoneGate(moved.ctx, false, kept);
    moved.devices.connectedPhone.mockResolvedValue({ deviceId: "phone-2", pairedAt: PAIRED });
    const made = call(kept);
    expect(await phoneCalendarRead(moved.ctx, made.call)).toHaveProperty(
      "error",
      expect.stringContaining("changed"),
    );
    // That call was allowed, so its result is kept like any other.
    expect(made.finished).toHaveLength(1);
    expect(moved.requests).toEqual([]);
  });

  it("refuses a run a token's message reached, without a phone request", async () => {
    const run = setup({ token: true });
    const result = await phoneCalendarRead(run.ctx, call({ ...RANGE }).call);
    expect(result).toHaveProperty("error", expect.stringContaining("token"));
    expect(run.requests).toEqual([]);
  });
});

describe("the owner's consent", () => {
  it("is a completed read, or this run's own approved card; nothing a crash can leave behind", async () => {
    const plan = async (status: string, runId: string) => {
      const run = setup({ consent: false });
      run.effects.push({ id: "e", runId, kind: PHONE_CALENDAR_READ_TOOL, status });
      return phoneGate(run.ctx, false, { ...RANGE });
    };
    expect(await plan("completed", "run-0")).toBe("allow");
    expect(await plan("approved", "run-1")).toBe("allow");
    for (const status of ["executing", "uncertain", "intended", "denied"])
      expect(await plan(status, "run-1"), status).toBe("ask");
    expect(await plan("approved", "run-0")).toBe("ask");
  });
});

describe("conversation memory", () => {
  it("knows a run that read the phone, which keeps its turn out of memory", async () => {
    const run = setup({ consent: false });
    expect(await runReadPhone(run.ctx)).toBe(false);
    run.effects.push({
      id: "e",
      runId: "run-1",
      kind: PHONE_CALENDAR_READ_TOOL,
      status: "intended",
    });
    expect(await runReadPhone(run.ctx)).toBe(true);
  });
});
