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

import { approvalDetailLength } from "./approval-ask.js";
import { withoutCloudComputerTools } from "./dozo-no-computer.js";
import {
  offerPhoneTools,
  PHONE_WRITES_PER_RUN,
  phoneCard,
  phoneGate,
  phoneRead,
  runReadPhone,
} from "./dozo-phone.js";
import type { Answer } from "./dozo-phone.test-support.js";
import { answers, call, failing, setup as phoneSetup } from "./dozo-phone.test-support.js";
import {
  PHONE_CALENDAR_CREATE_TOOL,
  PHONE_REMINDER_CREATE_TOOL,
  phoneCalendarCreateTool,
  phoneReminderCreateTool,
} from "./dozo-phone.tool-definition.js";
import { calendarCreateInput, reminderCreateInput } from "./dozo-phone-input.js";
import {
  phoneCalendarCreateRequest,
  phoneCalendarCreateValue,
  phoneReminderCreateRequest,
  phoneReminderCreateValue,
} from "./dozo-phone-protocol.js";
import { UserDeviceOfflineError } from "./user-device-gateway.js";

const DROPPED = "Your computer disconnected. Check the result before retrying.";
const EVENT_TOOL = PHONE_CALENDAR_CREATE_TOOL;
const REMINDER_TOOL = PHONE_REMINDER_CREATE_TOOL;
const TITLE = "Dentist with Dr. Example";
const NOTES = "Bring the referral letter\nand the insurance card";
const DAY = 24 * 60 * 60 * 1000;
/** An hour-long event two days from now, in a zone of its own. */
const at = (ms: number) => new Date(ms).toISOString().replace("Z", "+00:00");
const START = at(Math.floor(Date.now() / DAY) * DAY + 2 * DAY + 9 * 60 * 60 * 1000);
const END = at(Date.parse(START) + 60 * 60 * 1000);
/** The day of START, and the day after, as an all-day event gives them. */
const DAY_START = START.slice(0, 10);
const DAY_END = new Date(Date.parse(DAY_START) + DAY).toISOString().slice(0, 10);
const EVENT = { title: TITLE, start: START, end: END, location: "Clinic", notes: NOTES };
const REMINDER = { title: "Call the clinic", due: START, notes: NOTES, list: "Errands" };

const setup = (
  options: Omit<Parameters<typeof phoneSetup>[0], "answer" | "tool"> & { answer?: Answer } = {},
) =>
  phoneSetup({
    tool: EVENT_TOOL,
    answer: answers({ created: true, calendar: "Home" }),
    ...options,
  });

/** A call the owner allowed on its own card, then run: every write asks. */
async function write(
  run: ReturnType<typeof setup>,
  args: Record<string, unknown> = { ...EVENT },
  name: string = EVENT_TOOL,
) {
  run.effects.push({ id: "card", runId: "run-1", kind: name, status: "approved", request: args });
  const plan = await phoneGate(run.ctx, false, name, args);
  const made = call(name, args);
  return { plan, ...made, result: await phoneRead(run.ctx, made.call) };
}

afterEach(() => {
  logged.length = 0;
  vi.restoreAllMocks();
});

describe("a calendar write", () => {
  it("sends the whole event to the owner's phone by its id, and keeps only that it was created", async () => {
    const run = setup();
    const args = {
      ...EVENT,
      title: ` ${TITLE}\n`,
      all_day: false,
      recurrence: { frequency: "weekly", interval: 2, count: 10 },
    };
    const { plan, result, persisted } = await write(run, args);
    expect(plan).toBe("allow");
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "calendar-write");
    expect(run.requests).toEqual([
      {
        owner: "user-1",
        deviceId: "phone-1",
        request: {
          method: "phoneCalendarCreate",
          botId: "bot-1",
          runId: "run-1",
          event: {
            title: TITLE,
            start: START,
            end: END,
            allDay: false,
            location: "Clinic",
            notes: NOTES,
            recurrence: { frequency: "weekly", interval: 2, count: 10 },
          },
        },
      },
    ]);
    expect(phoneCalendarCreateRequest.safeParse(run.requests[0]!.request).success).toBe(true);
    expect(result).toEqual({ created: true, calendar: "Home" });
    expect(persisted).toEqual([{ created: true }]);
    for (const text of [TITLE, "Clinic", "referral", "Home"]) {
      expect(JSON.stringify(persisted)).not.toContain(text);
      expect(JSON.stringify(logged)).not.toContain(text);
    }
  });

  it.each([
    [{ title: "" }, "title"],
    [{ title: "t".repeat(201) }, "title can be at most 200 characters"],
    [{ location: "l".repeat(201) }, "location can be at most 200 characters"],
    [{ notes: "n".repeat(1001) }, "notes can be at most 1000 characters"],
    [{ start: "tomorrow at nine" }, "ISO 8601"],
    [{ end: START }, "end must be after start"],
    [{ end: at(Date.parse(START) + 32 * DAY) }, "at most 31 days"],
    [
      { start: at(Date.now() - 2 * DAY), end: at(Date.now() - 2 * DAY + 3_600_000) },
      "start must be",
    ],
    [
      { start: at(Date.now() + 800 * DAY), end: at(Date.now() + 800 * DAY + 3_600_000) },
      "start must be",
    ],
    [{ all_day: "yes" }, "all_day must be true or false"],
    [{ recurrence: { frequency: "weekly", interval: 1 } }, "count or until"],
    [{ recurrence: { frequency: "weekly" } }, "count or until"],
    [{ recurrence: { frequency: "weekly", count: 3, until: END } }, "count or until"],
    [{ recurrence: { frequency: "hourly", count: 3 } }, "frequency"],
    [{ recurrence: { frequency: "daily", interval: 31, count: 3 } }, "interval"],
    [{ recurrence: { frequency: "daily", count: 366 } }, "count"],
    [{ recurrence: { frequency: "daily", until: "never" } }, "until"],
    [{ recurrence: { frequency: "daily", until: at(Date.parse(START) - DAY) } }, "until"],
    [{ recurrence: { frequency: "daily", count: 2, alarms: [1] } }, "alarms"],
    [{ recurrence: "weekly" }, "recurrence"],
    [{ attendees: ["ada@example.test"] }, "attendees"],
    [{ invitees: ["ada@example.test"] }, "invitees"],
    [{ url: "https://x.example" }, "url"],
    [{ id: "event-1" }, "id"],
    [{ eventId: "event-1" }, "eventId"],
  ])("refuses %j before any card and before the phone", async (change, says) => {
    const run = setup();
    const args = { ...EVENT, ...change };
    const plan = await phoneGate(run.ctx, false, EVENT_TOOL, args);
    expect(plan).toBe("allow");
    const { call: made } = call(EVENT_TOOL, args);
    const result = (await phoneRead(run.ctx, made)) as { error: string };
    expect(result.error).toContain(says);
    expect(run.requests).toEqual([]);
    expect(run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "denied", result: { refused: "input" } } }),
    );
  });

  it("never modifies or deletes: an id names no event, and the protocol has no field for one", () => {
    const request = {
      method: "phoneCalendarCreate",
      botId: "bot-1",
      event: { title: TITLE, start: START, end: END, allDay: false },
    };
    expect(phoneCalendarCreateRequest.safeParse(request).success).toBe(true);
    for (const extra of [{ id: "e" }, { eventId: "e" }, { attendees: [] }])
      expect(
        phoneCalendarCreateRequest.safeParse({ ...request, event: { ...request.event, ...extra } })
          .success,
      ).toBe(false);
    expect(phoneCalendarCreateRequest.safeParse({ ...request, eventId: "e" }).success).toBe(false);
    expect(
      phoneCalendarCreateRequest.safeParse({
        ...request,
        event: { ...request.event, recurrence: { frequency: "daily", interval: 1 } },
      }).success,
    ).toBe(false);
    expect(Object.keys(phoneCalendarCreateTool.inputSchema.properties as object)).not.toContain(
      "attendees",
    );
    expect(phoneCalendarCreateTool.description).toMatch(/only creates/i);
    expect(phoneCalendarCreateTool.description).toMatch(/approves every/i);
    expect(phoneCalendarCreateTool.description).toMatch(/no invitees/i);
    expect(phoneReminderCreateTool.description).toMatch(/only creates/i);
    expect(phoneReminderCreateTool.description).toMatch(/approves every/i);
  });

  it("re-checks what the phone answers: created, and the calendar's name without links", () => {
    expect(
      phoneCalendarCreateValue({ created: true, calendar: "Home https://x.example/a" }),
    ).toEqual({
      created: true,
      calendar: "Home",
    });
    expect(phoneCalendarCreateValue({ created: true, calendar: "c".repeat(150), id: "x" })).toEqual(
      {
        created: true,
        calendar: "c".repeat(100),
      },
    );
    expect(phoneCalendarCreateValue({ created: false, calendar: "Home" })).toBeNull();
    expect(phoneCalendarCreateValue("done")).toBeNull();
    expect(phoneReminderCreateValue({ created: true, list: "Errands" })).toEqual({
      created: true,
      list: "Errands",
    });
    expect(phoneReminderCreateValue({ created: true })).toBeNull();
  });
});

describe("a write that fails", () => {
  it.each([
    ["calendar-write-off", "turn on Add to calendar in the app's Phone settings"],
    ["calendar-write-permission", "turn on Add to calendar in the app's Phone settings"],
    ["calendar-write-unavailable", "could not add the event"],
    ["calendar-write-invalid", "could not add the event as given"],
  ])("maps the phone's %s to one sentence, logging only its kind", async (code, says) => {
    const run = setup({ answer: failing(new Error(code)) });
    const { result } = await write(run);
    expect((result as { error: string }).error).toContain(says);
    expect(logged).toEqual([["warn", "phone calendar write failed", { kind: code }]]);
  });

  it("says it may have been written when the phone did not answer in time", async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadline.signal);
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
    const pending = write(run);
    await asked.promise;
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    expect((await pending).result).toEqual({
      error:
        "The user's phone did not answer in time, so it may have been added. Ask the user before trying again.",
      uncertain: true,
    });
  });

  it.each([
    ["the connection dropped after the request went out", new Error(DROPPED)],
    ["a forwarded request failed after it was handed off", new UserDeviceOfflineError()],
    ["the phone answered with no code it knows", new Error("calendar-off")],
  ])("says it may have been written when %s", async (_why, error) => {
    const run = setup({ answer: failing(error) });
    expect(((await write(run)).result as { error: string }).error).toContain(
      "so it may have been added. Ask the user before trying again.",
    );
    const reminder = phoneSetup({ tool: REMINDER_TOOL, answer: failing(error) });
    expect(
      ((await write(reminder, { ...REMINDER }, REMINDER_TOOL)).result as { error: string }).error,
    ).toContain("so it may have been added");
  });

  it("still says the phone is not connected when the write never left", async () => {
    const run = setup({ phone: false });
    const { result } = await write(run);
    expect((result as { error: string }).error).toContain("is not connected");
    expect(run.requests).toEqual([]);
  });

  it("says it may have been written when the answer cannot be read", async () => {
    const run = setup({ answer: answers({ ok: 1 }) });
    expect((await write(run)).result).toEqual({
      error:
        "The user's phone gave an answer that cannot be read, so it may have been added. Ask the user before trying again.",
      uncertain: true,
    });
  });
});

describe("a write's approval", () => {
  it("asks every call, whatever the bot wrote before: consent never carries", async () => {
    const run = setup();
    run.effects.push({ id: "w", runId: "run-0", kind: EVENT_TOOL, status: "completed" });
    expect(await phoneGate(run.ctx, false, EVENT_TOOL, { ...EVENT })).toBe("ask");
    // Its own card in this run lets it run, and no other call rides on it.
    run.effects.push({
      id: "c",
      runId: "run-1",
      kind: EVENT_TOOL,
      status: "approved",
      request: EVENT,
    });
    expect(await phoneGate(run.ctx, false, EVENT_TOOL, { ...EVENT })).toBe("allow");
    expect(await phoneGate(run.ctx, false, EVENT_TOOL, { ...EVENT, title: "Other" })).toBe("ask");
    // A completed write of this run is no card for the next.
    const later = setup();
    later.effects.push({
      id: "w",
      runId: "run-1",
      kind: EVENT_TOOL,
      status: "completed",
      request: EVENT,
    });
    expect(await phoneGate(later.ctx, false, EVENT_TOOL, { ...EVENT })).toBe("ask");
  });

  it("stops at three writes in a run, of either kind: the fourth is refused before the card", async () => {
    expect(PHONE_WRITES_PER_RUN).toBe(3);
    const run = setup();
    run.effects.push(
      { id: "w1", runId: "run-1", kind: EVENT_TOOL, status: "completed" },
      { id: "w2", runId: "run-1", kind: REMINDER_TOOL, status: "completed" },
      { id: "w3", runId: "run-1", kind: EVENT_TOOL, status: "completed" },
    );
    for (const [name, args] of [
      [EVENT_TOOL, { ...EVENT }],
      [REMINDER_TOOL, { ...REMINDER }],
    ] as const) {
      expect(await phoneGate(run.ctx, false, name, args)).toBe("allow");
      expect(await phoneRead(run.ctx, call(name, args).call)).toEqual({
        error: "A run may write to the user's phone at most 3 times. Ask the user to add the rest.",
      });
    }
    expect(run.requests).toEqual([]);
    const room = setup();
    room.effects.push(
      { id: "w1", runId: "run-1", kind: EVENT_TOOL, status: "completed" },
      { id: "w2", runId: "run-1", kind: REMINDER_TOOL, status: "completed" },
    );
    expect((await write(room)).result).toEqual({ created: true, calendar: "Home" });
  });

  it("counts a write still running or of unknown outcome as made, but not the asking call's own", async () => {
    for (const status of ["executing", "uncertain"]) {
      const run = setup();
      run.effects.push(
        { id: "w1", runId: "run-1", kind: EVENT_TOOL, status: "completed" },
        { id: "w2", runId: "run-1", kind: REMINDER_TOOL, status },
        { id: "w3", runId: "run-1", kind: EVENT_TOOL, status },
      );
      expect(await phoneGate(run.ctx, false, EVENT_TOOL, { ...EVENT })).toBe("allow");
      expect(await phoneRead(run.ctx, call(EVENT_TOOL, { ...EVENT }).call)).toEqual({
        error: "A run may write to the user's phone at most 3 times. Ask the user to add the rest.",
      });
    }
    // Two earlier writes, then the call itself starts executing: that is three, and it still runs.
    const room = setup();
    room.effects.push(
      { id: "w1", runId: "run-1", kind: EVENT_TOOL, status: "completed" },
      { id: "w2", runId: "run-1", kind: EVENT_TOOL, status: "uncertain" },
      { id: "card", runId: "run-1", kind: EVENT_TOOL, status: "approved", request: EVENT },
    );
    const args = { ...EVENT };
    expect(await phoneGate(room.ctx, false, EVENT_TOOL, args)).toBe("allow");
    room.effects.push({ id: "effect-1", runId: "run-1", kind: EVENT_TOOL, status: "executing" });
    expect(await phoneRead(room.ctx, call(EVENT_TOOL, args).call)).toEqual({
      created: true,
      calendar: "Home",
    });
  });

  it("is refused in a token's run, and a call its card did not see", async () => {
    const token = setup({ token: true });
    expect(await phoneGate(token.ctx, false, EVENT_TOOL, { ...EVENT })).toBe("deny");
    expect(await phoneRead(token.ctx, call(EVENT_TOOL, { ...EVENT }).call)).toHaveProperty(
      "error",
      expect.stringContaining("token"),
    );
    const unseen = setup();
    expect(await phoneRead(unseen.ctx, call(EVENT_TOOL, { ...EVENT }, true).call)).toHaveProperty(
      "error",
      expect.stringContaining("changed"),
    );
    expect([...token.requests, ...unseen.requests]).toEqual([]);
  });
});

describe("a write's card", () => {
  it("shows every field verbatim as code under a fixed question", () => {
    const args = {
      ...EVENT,
      all_day: false,
      recurrence: { frequency: "weekly", interval: 2, count: 10 },
    };
    expect(phoneCard("effect-1", EVENT_TOOL, args, [])).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Add this event to your phone's calendar?",
      detail: [
        `Title: ${TITLE}`,
        `Starts: ${START}`,
        `Ends: ${END}`,
        "All day: no",
        "Location: Clinic",
        "Repeats: every 2 weeks, 10 times",
        "Notes:",
        NOTES,
      ].join("\n"),
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(
      (
        phoneCard(
          "e",
          EVENT_TOOL,
          {
            title: TITLE,
            start: DAY_START,
            end: DAY_END,
            all_day: true,
            recurrence: { frequency: "daily", until: DAY_END },
          },
          [],
        ) as { detail: string }
      ).detail,
    ).toBe(
      [
        `Title: ${TITLE}`,
        `Starts: ${DAY_START}`,
        `Ends: ${DAY_END}`,
        "All day: yes",
        `Repeats: every day, until ${DAY_END}`,
      ].join("\n"),
    );
    expect(phoneCard("e", REMINDER_TOOL, { ...REMINDER }, [])).toMatchObject({
      text: "Add this reminder to your phone?",
      detail: ["Title: Call the clinic", `Due: ${START}`, "List: Errands", "Notes:", NOTES].join(
        "\n",
      ),
      detailFormat: "code",
    });
  });

  it("never puts the model's text in the question, and keeps one-line fields on one line", () => {
    const title = "**Lunch** [x](https://evil.example)\nAll day: yes\u202E";
    const card = phoneCard("e", EVENT_TOOL, { ...EVENT, title }, []) as {
      text: string;
      detail: string;
    };
    expect(card.text).toBe("Add this event to your phone's calendar?");
    expect(card.detail.split("\n")[0]).toBe(
      "Title: **Lunch** [x](https://evil.example) All day: yes",
    );
  });

  it("refuses a write that holds one of the bot's secrets: the card could not show it", async () => {
    const run = setup();
    (run.ctx as { secrets: string[] }).secrets = ["s3cr3t-value-123"];
    const args = { ...EVENT, notes: "token s3cr3t-value-123" };
    expect(await phoneGate(run.ctx, false, EVENT_TOOL, args)).toBe("allow");
    expect(await phoneRead(run.ctx, call(EVENT_TOOL, args).call)).toEqual({
      error: "This holds a secret of the bot's, which the approval card cannot show. Leave it out.",
    });
    expect(run.requests).toEqual([]);
  });

  it("always shows the longest write the limits allow in full", () => {
    const longest = {
      title: "t".repeat(200),
      start: START,
      end: END,
      all_day: false,
      location: "l".repeat(200),
      notes: "n".repeat(1000),
      recurrence: { frequency: "monthly", interval: 30, until: at(Date.parse(START) + 700 * DAY) },
    };
    const card = phoneCard("e", EVENT_TOOL, longest, []) as { detail: string };
    expect(card.detail).toContain("n".repeat(1000));
    expect(
      card.detail.length +
        "This run read outside content before asking.\nAn earlier try may have added this already.\n"
          .length,
    ).toBeLessThanOrEqual(approvalDetailLength(EVENT_TOOL));
  });

  it("says when the run read outside content before it asked", async () => {
    const tainted = setup({ tainted: true });
    const args = { ...EVENT };
    expect(await phoneGate(tainted.ctx, false, EVENT_TOOL, args)).toBe("ask");
    const card = phoneCard("e", EVENT_TOOL, args, []) as { detail: string };
    expect(card.detail.split("\n")[0]).toBe("This run read outside content before asking.");
    const clean = setup();
    const other = { ...EVENT };
    expect(await phoneGate(clean.ctx, false, EVENT_TOOL, other)).toBe("ask");
    expect((phoneCard("e", EVENT_TOOL, other, []) as { detail: string }).detail).not.toContain(
      "outside content",
    );
  });
});

describe("a write after one that may have been made", () => {
  const first = (detail: string) => detail.split("\n").slice(0, 2);
  const cardOf = async (run: ReturnType<typeof setup>) => {
    const args = { ...EVENT };
    expect(await phoneGate(run.ctx, false, EVENT_TOOL, args)).toBe("ask");
    return (phoneCard("e", EVENT_TOOL, args, []) as { detail: string }).detail;
  };

  it("says an earlier try may have added it already, below the outside-content line", async () => {
    for (const earlier of [
      { status: "uncertain" },
      { status: "completed", result: { error: "so it may have been added", uncertain: true } },
    ]) {
      const run = setup();
      run.effects.push({ id: "w1", runId: "run-1", kind: REMINDER_TOOL, ...earlier });
      expect((await cardOf(run)).split("\n")[0]).toBe(
        "An earlier try may have added this already.",
      );
    }
    const both = setup({ tainted: true });
    both.effects.push({ id: "w1", runId: "run-1", kind: EVENT_TOOL, status: "uncertain" });
    expect(first(await cardOf(both))).toEqual([
      "This run read outside content before asking.",
      "An earlier try may have added this already.",
    ]);
  });

  it("stays quiet after clean writes, other runs' tries and reads", async () => {
    const run = setup();
    run.effects.push(
      {
        id: "w1",
        runId: "run-1",
        kind: EVENT_TOOL,
        status: "completed",
        result: { created: true },
      },
      { id: "w2", runId: "run-0", kind: EVENT_TOOL, status: "uncertain" },
      { id: "w3", runId: "run-1", kind: "phone_calendar_read", status: "uncertain" },
    );
    expect(await cardOf(run)).not.toContain("earlier try");
  });

  it("is what a write that got no readable answer leaves in its effect", async () => {
    const run = setup({ answer: answers({ ok: 1 }) });
    const { persisted } = await write(run);
    expect(persisted).toEqual([expect.objectContaining({ uncertain: true })]);
  });
});

describe("a reminder write", () => {
  it("sends the reminder and keeps only that it was created", async () => {
    const run = setup({ answer: answers({ created: true, list: "Errands" }) });
    const { plan, result, persisted } = await write(run, { ...REMINDER }, REMINDER_TOOL);
    expect(plan).toBe("allow");
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "reminders-write");
    expect(run.requests[0]?.request).toEqual({
      method: "phoneReminderCreate",
      botId: "bot-1",
      runId: "run-1",
      reminder: { title: "Call the clinic", due: START, notes: NOTES, list: "Errands" },
    });
    expect(phoneReminderCreateRequest.safeParse(run.requests[0]!.request).success).toBe(true);
    expect(result).toEqual({ created: true, list: "Errands" });
    expect(persisted).toEqual([{ created: true }]);
    expect(JSON.stringify([persisted, logged])).not.toMatch(/clinic|referral|Errands/);
  });

  it.each([
    [{ title: "t".repeat(201) }, "title can be at most 200 characters"],
    [{ notes: "n".repeat(1001) }, "notes can be at most 1000 characters"],
    [{ list: "l".repeat(101) }, "list can be at most 100 characters"],
    [{ due: "friday" }, "ISO 8601"],
    [{ id: "r-1" }, "id"],
    [{ assignee: "bob" }, "assignee"],
  ])("refuses %j before any card", async (change, says) => {
    const run = setup();
    const args = { ...REMINDER, ...change };
    expect(await phoneGate(run.ctx, false, REMINDER_TOOL, args)).toBe("allow");
    expect(
      ((await phoneRead(run.ctx, call(REMINDER_TOOL, args).call)) as { error: string }).error,
    ).toContain(says);
    expect(run.requests).toEqual([]);
  });

  it("maps the phone's errors to its own switch", async () => {
    const run = setup({ answer: failing(new Error("reminders-write-off")) });
    expect((await write(run, { ...REMINDER }, REMINDER_TOOL)).result).toEqual({
      error:
        "Add reminders is off on the user's phone. Ask them to turn on Add reminders in the app's Phone settings.",
    });
    const noList = setup({ answer: failing(new Error("reminders-write-list")) });
    expect((await write(noList, { ...REMINDER }, REMINDER_TOOL)).result).toEqual({
      error: "The phone has no reminders list with that name; ask the user which list to use.",
    });
    const invalid = setup({ answer: failing(new Error("reminders-write-invalid")) });
    expect((await write(invalid, { ...REMINDER }, REMINDER_TOOL)).result).toHaveProperty(
      "error",
      expect.stringContaining("could not add the reminder as given"),
    );
  });
});

describe("where writes are offered", () => {
  it("only while the phone declares that switch", async () => {
    const offered = async (capabilities: string[]) => {
      const run = setup({ capabilities });
      const off = withoutCloudComputerTools(new Set(), false);
      await offerPhoneTools(
        run.ctx.deps as never,
        run.ctx.run,
        run.ctx.thread,
        "user-1",
        off,
        null,
      );
      return [EVENT_TOOL, REMINDER_TOOL].filter((name) => !off.has(name));
    };
    expect(await offered(["calendar", "reminders"])).toEqual([]);
    expect(await offered(["calendar-write"])).toEqual([EVENT_TOOL]);
    expect(await offered(["reminders-write"])).toEqual([REMINDER_TOOL]);
  });

  it("keeps a turn that wrote to the phone out of memory", async () => {
    const run = setup({ consent: false });
    expect(await runReadPhone(run.ctx)).toBe(false);
    run.effects.push({ id: "e", runId: "run-1", kind: REMINDER_TOOL, status: "completed" });
    expect(await runReadPhone(run.ctx)).toBe(true);
  });
});

/**
 * The same write samples, row for row, in the phone's tests (apps/mobile/lib/
 * dozo-phone-calendar-write.test.ts and dozo-phone-reminders-write.test.ts) and here: each side
 * runs them through its own path, so the phone and the server accept and refuse the same items.
 * Items are as the wire carries them, at SAMPLE_NOW.
 */
const SAMPLE_NOW = Date.parse("2026-11-23T12:00:00.000Z");
const TIMED = {
  title: "Dentist",
  start: "2026-11-24T09:00:00+00:00",
  end: "2026-11-24T10:00:00+00:00",
  allDay: false,
};
const EVENT_SAMPLES: Array<[string, Record<string, unknown>, boolean]> = [
  ["a timed event", TIMED, true],
  ["an all-day day", { title: "Trip", start: "2026-12-01", end: "2026-12-02", allDay: true }, true],
  ["an all-day event given times", { ...TIMED, allDay: true }, false],
  ["a timed event given dates", { ...TIMED, start: "2026-12-01", end: "2026-12-02" }, false],
  [
    "a time without an offset",
    { ...TIMED, start: "2026-11-24T09:00:00", end: "2026-11-24T10:00:00" },
    false,
  ],
  [
    "a date that does not exist",
    { title: "Trip", start: "2026-02-30", end: "2026-03-01", allDay: true },
    false,
  ],
  ["a title of 200", { ...TIMED, title: "t".repeat(200) }, true],
  ["a title of 201", { ...TIMED, title: "t".repeat(201) }, false],
  ["a location of 201", { ...TIMED, location: "l".repeat(201) }, false],
  ["notes of 1000", { ...TIMED, notes: "n".repeat(1000) }, true],
  ["notes of 1001", { ...TIMED, notes: "n".repeat(1001) }, false],
  ["31 days", { ...TIMED, end: "2026-12-25T09:00:00+00:00" }, true],
  ["over 31 days", { ...TIMED, end: "2026-12-25T09:00:01+00:00" }, false],
  ["an end at the start", { ...TIMED, end: TIMED.start }, false],
  [
    "a start a day ago",
    { ...TIMED, start: "2026-11-22T12:00:00+00:00", end: "2026-11-22T13:00:00+00:00" },
    true,
  ],
  [
    "a start over a day ago",
    { ...TIMED, start: "2026-11-22T11:59:00+00:00", end: "2026-11-22T13:00:00+00:00" },
    false,
  ],
  [
    "a start 730 days ahead",
    { ...TIMED, start: "2028-11-22T12:00:00+00:00", end: "2028-11-22T13:00:00+00:00" },
    true,
  ],
  [
    "a start past 730 days",
    { ...TIMED, start: "2028-11-22T12:00:01+00:00", end: "2028-11-22T13:00:00+00:00" },
    false,
  ],
  [
    "a repeat by count",
    { ...TIMED, recurrence: { frequency: "weekly", interval: 2, count: 10 } },
    true,
  ],
  [
    "a repeat until a time",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, until: "2026-12-24T09:00:00+00:00" },
    },
    true,
  ],
  [
    "an all-day repeat until a date",
    {
      title: "Gym",
      start: "2026-12-01",
      end: "2026-12-02",
      allDay: true,
      recurrence: { frequency: "weekly", interval: 1, until: "2027-01-01" },
    },
    true,
  ],
  [
    "a repeat by count and until",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, count: 3, until: "2026-12-24T09:00:00+00:00" },
    },
    false,
  ],
  [
    "a repeat that never ends",
    { ...TIMED, recurrence: { frequency: "daily", interval: 1 } },
    false,
  ],
  [
    "an interval of 31",
    { ...TIMED, recurrence: { frequency: "daily", interval: 31, count: 2 } },
    false,
  ],
  [
    "a count of 366",
    { ...TIMED, recurrence: { frequency: "daily", interval: 1, count: 366 } },
    false,
  ],
  [
    "an until before the start",
    {
      ...TIMED,
      recurrence: { frequency: "daily", interval: 1, until: "2026-11-23T00:00:00+00:00" },
    },
    false,
  ],
  [
    "a repeat by weekday",
    { ...TIMED, recurrence: { frequency: "weekly", interval: 1, count: 2, byDay: ["MO"] } },
    false,
  ],
  ["attendees", { ...TIMED, attendees: ["ada@example.test"] }, false],
  ["an id", { ...TIMED, id: "event-1" }, false],
  ["an eventId", { ...TIMED, eventId: "event-1" }, false],
  ["a link", { ...TIMED, url: "https://example.test" }, false],
];
const REMINDER_SAMPLES: Array<[string, Record<string, unknown>, boolean]> = [
  ["a reminder", { title: "Buy milk" }, true],
  ["one due at a time", { title: "Buy milk", due: "2026-11-24T09:00:00+00:00" }, true],
  ["one due without an offset", { title: "Buy milk", due: "2026-11-24T09:00:00" }, false],
  ["one due on a date", { title: "Buy milk", due: "2026-11-24" }, false],
  ["no title", { title: "" }, false],
  ["a list of 100", { title: "Buy milk", list: "l".repeat(100) }, true],
  ["a list of 101", { title: "Buy milk", list: "l".repeat(101) }, false],
  ["notes of 1001", { title: "Buy milk", notes: "n".repeat(1001) }, false],
  ["an id", { title: "Buy milk", id: "r-1" }, false],
  ["alarms", { title: "Buy milk", alarms: [1] }, false],
];

/** A wire item as the model gives it to the tool. */
const asArgs = ({ allDay, ...rest }: Record<string, unknown>) => ({
  ...rest,
  ...(allDay === undefined ? {} : { all_day: allDay }),
});

describe("the write samples the phone checks too", () => {
  it.each(EVENT_SAMPLES)("an event: %s, accepted %s", (_name, item, ok) => {
    const input = calendarCreateInput(asArgs(item), SAMPLE_NOW);
    expect("error" in input).toBe(!ok);
  });

  it.each(REMINDER_SAMPLES)("a reminder: %s, accepted %s", (_name, item, ok) => {
    expect("error" in reminderCreateInput(item)).toBe(!ok);
  });
});

describe("a repeat with no interval", () => {
  it.each([null, undefined])("repeats every 1 when interval is %s", (interval) => {
    const input = calendarCreateInput(
      { ...EVENT, recurrence: { frequency: "daily", count: 3, interval } },
      Date.now(),
    );
    expect(input).toHaveProperty("item.recurrence", { frequency: "daily", interval: 1, count: 3 });
  });
});

describe("an all-day event", () => {
  it("carries its dates, never times, to the phone and on the card, in any server zone", async () => {
    for (const zone of ["UTC", "America/Los_Angeles", "Asia/Tokyo"]) {
      process.env.TZ = zone;
      const args = { title: "Holiday", start: "2026-03-01", end: "2026-03-02", all_day: true };
      const input = calendarCreateInput(args, Date.parse("2026-02-27T12:00:00Z"));
      expect(input).toEqual({
        item: { title: "Holiday", start: "2026-03-01", end: "2026-03-02", allDay: true },
        lines: ["Title: Holiday", "Starts: 2026-03-01", "Ends: 2026-03-02", "All day: yes"],
      });
    }
    process.env.TZ = "UTC";
    const timed = calendarCreateInput(
      {
        title: "Holiday",
        start: "2026-03-01T00:00:00+00:00",
        end: "2026-03-02T00:00:00+00:00",
        all_day: true,
      },
      Date.parse("2026-02-27T12:00:00Z"),
    );
    expect(timed).toHaveProperty("error", expect.stringContaining("dates, such as 2026-03-01"));
  });
});

describe("a reminder in the default list", () => {
  it("tells the model the default list when the phone could not name it", async () => {
    expect(phoneReminderCreateValue({ created: true, list: "" })).toEqual({
      created: true,
      list: "default list",
    });
    const run = setup({ answer: answers({ created: true, list: "" }) });
    expect((await write(run, { ...REMINDER }, REMINDER_TOOL)).result).toEqual({
      created: true,
      list: "default list",
    });
  });
});
