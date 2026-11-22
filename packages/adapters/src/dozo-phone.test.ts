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
  phoneGate,
  phoneInput,
  phoneRead,
  phoneRoute,
  runReadPhone,
} from "./dozo-phone.js";
import type { Answer } from "./dozo-phone.test-support.js";
import {
  answers,
  failing,
  PAIRED,
  call as phoneCall,
  setup as phoneSetup,
} from "./dozo-phone.test-support.js";
import { PHONE_CALENDAR_READ_TOOL } from "./dozo-phone.tool-definition.js";
import { phoneCalendarValue } from "./dozo-phone-protocol.js";
import { USER_DEVICE_OFFLINE_MESSAGE, UserDeviceOfflineError } from "./user-device-gateway.js";

/**
 * The same raw events and what is left of them, word for word in the phone's test
 * (apps/mobile/lib/dozo-phone-calendar.test.ts) and the server's (dozo-phone.test.ts): both run
 * them through their own path, so the phone and the server give the same output.
 */
const LINK_SAMPLES = [
  {
    raw: {
      title: "Standup https://x.example/j/1?pwd=abc",
      location: "zoom.us / j / 123",
      calendar: "Team meet.google.com",
    },
    kept: { title: "Standup", calendar: "Team" },
  },
  {
    raw: { title: "Call tel:+1 555 0100,,123456#", location: "Room 4.2", calendar: "Work" },
    kept: { title: "Call", location: "Room 4.2", calendar: "Work" },
  },
  {
    raw: { title: "Passcode: abc123", location: "zoom\uFF0Eus\uFF0Fj\uFF0F123", calendar: "Home" },
    kept: { title: "Passcode: abc123", calendar: "Home" },
  },
  {
    raw: {
      title: "https://only.example",
      location: "Main St. 12/3, Berlin",
      calendar: "Dr. Smith",
    },
    kept: { title: "", location: "Main St. 12/3, Berlin", calendar: "Dr. Smith" },
  },
];

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

/** A run whose phone answers with EVENT unless told otherwise. */
const setup = (
  options: Omit<Parameters<typeof phoneSetup>[0], "answer"> & { answer?: Answer } = {},
) => phoneSetup({ answer: answers({ events: [EVENT], truncated: false }), ...options });
const call = (args: Record<string, unknown>, claimed = false) =>
  phoneCall(PHONE_CALENDAR_READ_TOOL, args, claimed);

/** The gate, then the handler, as the executor runs a call that passed its approval. */
async function read(run: ReturnType<typeof setup>, args: Record<string, unknown> = { ...RANGE }) {
  const plan = await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args);
  const made = call(args);
  return { plan, ...made, result: await phoneRead(run.ctx, made.call) };
}

afterEach(() => {
  logged.length = 0;
  vi.restoreAllMocks();
});

describe("the phone a run reaches", () => {
  it("is the owner's connected phone with Calendar on, in their own run only", async () => {
    const run = setup();
    expect(await phoneRoute(run.ctx, "calendar")).toMatchObject({
      owner: "user-1",
      deviceId: "phone-1",
    });
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "calendar");
    expect(await phoneRoute(setup({ owner: undefined }).ctx, "calendar")).toBeUndefined();
    expect(await phoneRoute(setup({ phone: false }).ctx, "calendar")).toBeUndefined();
    // A gateway that cannot reach phones (the desktop server's own) has none.
    const plain = setup();
    (plain.ctx.deps as { userDevices: unknown }).userDevices = { connected: async () => null };
    expect(await phoneRoute(plain.ctx, "calendar")).toBeUndefined();
    expect(isPhoneTool(PHONE_CALENDAR_READ_TOOL)).toBe(true);
    expect(isPhoneTool("user_computer_shell")).toBe(false);
  });

  it("is offered only while the phone is there, the bot keeps it and no token reached the run", async () => {
    const RUN = { botId: "bot-1", threadId: "t" };
    const offered = async (run: ReturnType<typeof setup>, botDisabled: string[] | null = null) => {
      const off = withoutCloudComputerTools(new Set(), false);
      await offerPhoneTools(run.ctx.deps as never, RUN, run.ctx.thread, "user-1", off, botDisabled);
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

  it("takes links out of the title, the place and the calendar's name, as the phone does", () => {
    const value = phoneCalendarValue({
      events: LINK_SAMPLES.map(({ raw }) => ({ ...EVENT, ...raw })),
      truncated: false,
    });
    expect(
      value?.events.map(({ title, location, calendar }) => ({ title, location, calendar })),
    ).toEqual(LINK_SAMPLES.map(({ kept }) => ({ location: undefined, ...kept })));
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
    await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args);
    const made = call(args);
    vi.mocked(made.call.persistEffectResult).mockResolvedValueOnce(false);
    const result = await phoneRead(run.ctx, made.call);
    expect(result).toHaveProperty("uncertain", true);
    expect(JSON.stringify(result)).not.toContain(SECRET_TITLE);
  });
});

describe("a read that fails", () => {
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
    await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args);
    const pending = phoneRead(run.ctx, call(args).call);
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
    await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args);
    const pending = phoneRead(run.ctx, call(args).call);
    await asked.promise;
    stop.abort(new Error("stopped"));
    await expect(pending).rejects.toThrow("stopped");
  });

  it("refuses at execution when the phone left after the run was offered it", async () => {
    const run = setup();
    const args = { ...RANGE };
    expect(await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args)).toBe("allow");
    run.devices.connectedPhone.mockResolvedValue(null);
    const result = await phoneRead(run.ctx, call(args).call);
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
    expect(await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args)).toBe("ask");
    const asked = call(args, true);
    expect(await phoneRead(run.ctx, asked.call)).toHaveProperty(
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
    await phoneGate(moved.ctx, false, PHONE_CALENDAR_READ_TOOL, kept);
    moved.devices.connectedPhone.mockResolvedValue({
      deviceId: "phone-2",
      pairedAt: PAIRED,
      onSince: PAIRED,
    });
    const made = call(kept);
    expect(await phoneRead(moved.ctx, made.call)).toHaveProperty(
      "error",
      expect.stringContaining("changed"),
    );
    // That call was allowed, so its result is kept like any other.
    expect(made.finished).toHaveLength(1);
    expect(moved.requests).toEqual([]);
  });

  it("refuses a run a token's message reached, without a phone request", async () => {
    const run = setup({ token: true });
    const result = await phoneRead(run.ctx, call({ ...RANGE }).call);
    expect(result).toHaveProperty("error", expect.stringContaining("token"));
    expect(run.requests).toEqual([]);
  });
});

describe("the owner's consent", () => {
  it("is a completed read, or this run's own approved card; nothing a crash can leave behind", async () => {
    const plan = async (status: string, runId: string) => {
      const run = setup({ consent: false });
      run.effects.push({ id: "e", runId, kind: PHONE_CALENDAR_READ_TOOL, status, request: RANGE });
      return phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE });
    };
    expect(await plan("completed", "run-0")).toBe("allow");
    expect(await plan("approved", "run-1")).toBe("allow");
    for (const status of ["executing", "uncertain", "intended", "denied"])
      expect(await plan(status, "run-1"), status).toBe("ask");
    expect(await plan("approved", "run-0")).toBe("ask");
  });
});

describe("calls in the same run", () => {
  it("runs only the call whose own card was approved, not another one beside it", async () => {
    const run = setup({ consent: false });
    const first = { ...RANGE };
    const second = { from: "2026-12-01T00:00:00+03:00", to: "2026-12-02T00:00:00+03:00" };
    // A's card was allowed; A has not run yet.
    run.effects.push({
      id: "a",
      runId: "run-1",
      kind: PHONE_CALENDAR_READ_TOOL,
      status: "approved",
      request: first,
    });
    expect(await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, second)).toBe("ask");
    expect(await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, { ...first })).toBe("allow");
  });
});

describe("calls in one model turn", () => {
  it("lets only the first through without a card, however many run at once", async () => {
    const run = setup();
    const days = Array.from({ length: 5 }, (_, day) => ({
      from: `2026-12-0${day + 1}T00:00:00+03:00`,
      to: `2026-12-0${day + 2}T00:00:00+03:00`,
    }));
    const plans = await Promise.all(
      days.map((args) => phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, args)),
    );
    expect(plans.filter((plan) => plan === "allow")).toHaveLength(1);
    expect(plans.filter((plan) => plan === "ask")).toHaveLength(4);
    // Allowed is read: the run counts as having taken in outside content.
    expect((run.ctx.state as { tainted: boolean }).tainted).toBe(true);
  });
});

describe("a run that took in outside content", () => {
  it("asks before every read, even with the owner's consent", async () => {
    expect(await phoneGate(setup().ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE })).toBe(
      "allow",
    );
    expect(
      await phoneGate(setup({ tainted: true }).ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE }),
    ).toBe("ask");
    // The card the owner just allowed for this call lets it run.
    const answered = setup({ tainted: true });
    answered.effects.push({
      id: "e",
      runId: "run-1",
      kind: PHONE_CALENDAR_READ_TOOL,
      status: "approved",
      request: RANGE,
    });
    expect(await phoneGate(answered.ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE })).toBe(
      "allow",
    );
  });
});

describe("a thread someone else can read", () => {
  it("never reaches the phone: a group, a channel, a helper's thread, or a Space shared with others", async () => {
    for (const run of [
      setup({ thread: { groupId: "group-1" } }),
      setup({ thread: { externalConversationId: "conversation-1" } }),
      setup({ thread: { helperBotId: "bot-2" } }),
      setup({ otherMember: true }),
    ]) {
      expect(await phoneRoute(run.ctx, "calendar")).toBeUndefined();
      expect(await phoneGate(run.ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE })).toBe("deny");
      const off = withoutCloudComputerTools(new Set(), false);
      await offerPhoneTools(
        run.ctx.deps as never,
        run.ctx.run,
        run.ctx.thread,
        "user-1",
        off,
        null,
      );
      expect(off.has(PHONE_CALENDAR_READ_TOOL)).toBe(true);
      expect(run.requests).toEqual([]);
    }
    const solo = setup();
    expect(await phoneRoute(solo.ctx, "calendar")).toMatchObject({ deviceId: "phone-1" });
    expect(solo.prisma.spaceMember.findFirst).toHaveBeenCalledWith({
      where: { spaceId: "space-1", userId: { not: "user-1" } },
      select: { id: true },
    });
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
    // A run that cannot reach a phone looks nothing up; one whose gate saw a call needs no lookup.
    const other = setup({ owner: undefined });
    expect(await runReadPhone(other.ctx)).toBe(false);
    const plain = setup();
    (plain.ctx.deps as { userDevices?: unknown }).userDevices = undefined;
    expect(await runReadPhone(plain.ctx)).toBe(false);
    const asked = setup({ consent: false });
    await phoneGate(asked.ctx, false, PHONE_CALENDAR_READ_TOOL, { ...RANGE });
    asked.findFirst.mockClear();
    expect(await runReadPhone(asked.ctx)).toBe(true);
    expect(other.findFirst).not.toHaveBeenCalled();
    expect(asked.findFirst).not.toHaveBeenCalled();
  });
});
