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
  PHONE_REMINDERS_NOTE,
  phoneCard,
  phoneGate,
  phoneRead,
  runReadPhone,
} from "./dozo-phone.js";
import type { Answer } from "./dozo-phone.test-support.js";
import { answers, call, failing, setup as phoneSetup } from "./dozo-phone.test-support.js";
import {
  PHONE_CALENDAR_READ_TOOL,
  PHONE_REMINDERS_READ_TOOL,
} from "./dozo-phone.tool-definition.js";
import { phoneRemindersReadRequest, phoneRemindersValue } from "./dozo-phone-protocol.js";
import { USER_DEVICE_OFFLINE_MESSAGE } from "./user-device-gateway.js";

const TOOL = PHONE_REMINDERS_READ_TOOL;
const SECRET_TITLE = "Pick up the biopsy results";
const REMINDER = {
  title: SECRET_TITLE,
  due: "2026-11-23T09:00:00+03:00",
  done: false,
  list: "Home",
};
const RANGE = { due_from: "2026-11-22T00:00:00+03:00", due_to: "2026-11-29T00:00:00+03:00" };

const setup = (
  options: Omit<Parameters<typeof phoneSetup>[0], "answer" | "tool"> & { answer?: Answer } = {},
) =>
  phoneSetup({
    tool: TOOL,
    answer: answers({ reminders: [REMINDER], truncated: false }),
    ...options,
  });

async function read(run: ReturnType<typeof setup>, args: Record<string, unknown> = {}) {
  const plan = await phoneGate(run.ctx, false, TOOL, args);
  const made = call(TOOL, args);
  return { plan, ...made, result: await phoneRead(run.ctx, made.call) };
}

afterEach(() => {
  logged.length = 0;
  vi.restoreAllMocks();
});

describe("a reminders read", () => {
  it("sends what it asks for to the owner's phone by its id and gives the model the reminders", async () => {
    const run = setup();
    const { plan, result, persisted } = await read(run, {
      ...RANGE,
      list: " Home\n",
      include_done: true,
    });
    expect(plan).toBe("allow");
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "reminders");
    expect(run.requests).toEqual([
      {
        owner: "user-1",
        deviceId: "phone-1",
        request: {
          method: "phoneRemindersRead",
          botId: "bot-1",
          runId: "run-1",
          list: "Home",
          due: { from: RANGE.due_from, to: RANGE.due_to },
          includeDone: true,
          limit: 50,
        },
      },
    ]);
    expect(phoneRemindersReadRequest.safeParse(run.requests[0]!.request).success).toBe(true);
    expect(result).toEqual({ reminders: [REMINDER], truncated: false });
    // The effect keeps how many, never what they say.
    expect(persisted).toEqual([{ reminders: 1, note: PHONE_REMINDERS_NOTE }]);
    for (const text of [SECRET_TITLE, "Home"]) {
      expect(JSON.stringify(persisted)).not.toContain(text);
      expect(JSON.stringify(logged)).not.toContain(text);
    }
  });

  it("asks for open reminders of every list and date by default", async () => {
    const run = setup();
    await read(run);
    expect(run.requests[0]?.request).toEqual({
      method: "phoneRemindersRead",
      botId: "bot-1",
      runId: "run-1",
      includeDone: false,
      limit: 50,
    });
  });

  it.each([
    [{ due_from: RANGE.due_from }, "due_from and due_to go together"],
    [{ due_to: RANGE.due_to }, "due_from and due_to go together"],
    [{ due_from: "tomorrow", due_to: RANGE.due_to }, "ISO 8601"],
    [{ due_from: RANGE.due_to, due_to: RANGE.due_from }, "due_to must be after due_from"],
    [{ due_from: "2026-11-01T00:00:00Z", due_to: "2026-12-03T00:00:00Z" }, "at most 31 days"],
    [{ list: "l".repeat(101) }, "list can be at most 100 characters"],
    [{ list: 5 }, "list must be text"],
    [{ include_done: "yes" }, "include_done must be true or false"],
  ])("refuses %j before the phone, without a card", async (args, says) => {
    const run = setup({ consent: false });
    const { plan, result } = await read(run, args);
    expect(plan).toBe("allow");
    expect((result as { error: string }).error).toContain(says);
    expect(run.requests).toEqual([]);
    expect(run.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { status: "denied", result: { refused: "input" } } }),
    );
  });

  it("caps what the phone sends: 50 reminders, sorted by due with undated last, cut fields, nothing else", () => {
    const many = Array.from({ length: 55 }, (_, index) => ({
      title: `${"t".repeat(250)}${index}`,
      ...(index % 2 ? { due: new Date(Date.UTC(2026, 10, 30 - (index % 20))).toISOString() } : {}),
      done: false,
      list: "L".repeat(150),
      notes: "private note",
      url: "https://x.example",
      id: "reminder-id",
      priority: 1,
      location: "Clinic",
      alarms: [1],
    }));
    const value = phoneRemindersValue({ reminders: many, truncated: false, extra: 1 })!;
    expect(value.truncated).toBe(true);
    expect(value.reminders).toHaveLength(50);
    expect(Object.keys(value.reminders[0]!).sort()).toEqual(["done", "due", "list", "title"]);
    expect(value.reminders[0]!.title).toHaveLength(200);
    expect(value.reminders[0]!.list).toHaveLength(100);
    const dues = value.reminders.map((reminder) => reminder.due);
    const dated = dues.filter(Boolean) as string[];
    expect(dated).toEqual([...dated].sort((a, b) => Date.parse(a) - Date.parse(b)));
    expect(dues.indexOf(undefined)).toBe(dated.length);
    expect(JSON.stringify(value)).not.toMatch(/private note|x\.example|reminder-id|Clinic|alarms/);
  });

  it("takes links out of titles and list names, drops what it cannot read, and refuses an answer that is none", () => {
    expect(
      phoneRemindersValue({
        reminders: [
          { title: "Call https://x.example/j/1?pwd=abc", done: true, list: "Team meet.google.com" },
          { title: "https://only.example", done: false },
          { title: "No done flag" },
          { title: "Bad due", done: false, due: "soon" },
          "x",
        ],
        truncated: false,
      }),
    ).toEqual({
      reminders: [
        { title: "Call", done: true, list: "Team" },
        { title: "", done: false },
      ],
      truncated: false,
    });
    expect(phoneRemindersValue("nope")).toBeNull();
    expect(phoneRemindersValue({ reminders: "all", truncated: false })).toBeNull();
  });

  it("tells the model an unreadable answer, logging only that it was", async () => {
    const run = setup({ answer: answers({ reminders: [REMINDER] }) });
    const { result } = await read(run);
    expect(result).toEqual({ error: "The user's phone could not read its reminders." });
    expect(logged).toEqual([["warn", "phone reminders read failed", { kind: "invalid" }]]);
  });
});

describe("a reminders read that fails", () => {
  it.each([
    ["reminders-off", "turn on Reminders in the app's Phone settings"],
    ["reminders-permission", "turn on Reminders in the app's Phone settings"],
    ["reminders-unavailable", "could not read its reminders"],
    ["calendar-off", "could not read its reminders"],
  ])("maps the phone's %s to one sentence, logging only its kind", async (code, says) => {
    const run = setup({ answer: failing(new Error(code)) });
    const { result } = await read(run);
    expect((result as { error: string }).error).toContain(says);
    expect(logged).toEqual([
      ["warn", "phone reminders read failed", { kind: code === "calendar-off" ? "other" : code }],
    ]);
  });

  it("asks the user to open the app when the phone went away", async () => {
    const run = setup({ answer: failing(new Error(USER_DEVICE_OFFLINE_MESSAGE)) });
    expect((await read(run)).result).toHaveProperty(
      "error",
      expect.stringContaining("open the app on their phone"),
    );
  });

  it("gives up after 20 seconds", async () => {
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
    const args = {};
    await phoneGate(run.ctx, false, TOOL, args);
    const pending = phoneRead(run.ctx, call(TOOL, args).call);
    await asked.promise;
    expect(timeout).toHaveBeenCalledWith(PHONE_ANSWER_MS);
    deadline.abort(new DOMException("timed out", "TimeoutError"));
    expect(await pending).toEqual({
      error: "The user's phone did not answer in time. Ask them to keep the app open.",
    });
  });

  it("refuses a token's run, and a call its approval did not see", async () => {
    const token = setup({ token: true });
    expect(await phoneRead(token.ctx, call(TOOL, {}).call)).toHaveProperty(
      "error",
      expect.stringContaining("token"),
    );
    const unseen = setup({ consent: false });
    expect(await phoneGate(unseen.ctx, false, TOOL, {})).toBe("ask");
    expect(await phoneRead(unseen.ctx, call(TOOL, {}, true).call)).toHaveProperty(
      "error",
      expect.stringContaining("changed"),
    );
    expect([...token.requests, ...unseen.requests]).toEqual([]);
  });
});

describe("the owner's consent to reminders", () => {
  it("is a read of this tool: a calendar read does not count", async () => {
    const run = setup({ consent: false });
    run.effects.push({
      id: "c",
      runId: "run-0",
      kind: PHONE_CALENDAR_READ_TOOL,
      status: "completed",
    });
    expect(await phoneGate(run.ctx, false, TOOL, {})).toBe("ask");
    expect(await phoneGate(setup().ctx, false, TOOL, {})).toBe("allow");
  });

  it("asks every read once outside content entered the run, except its own approved card", async () => {
    expect(await phoneGate(setup({ tainted: true }).ctx, false, TOOL, {})).toBe("ask");
    const answered = setup({ tainted: true });
    answered.effects.push({ id: "e", runId: "run-1", kind: TOOL, status: "approved", request: {} });
    expect(await phoneGate(answered.ctx, false, TOOL, {})).toBe("allow");
    expect(await phoneGate(answered.ctx, false, TOOL, { include_done: true })).toBe("ask");
  });

  it("lets only the first of many calls at once go without a card, and taints the run", async () => {
    const run = setup();
    const plans = await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        phoneGate(run.ctx, false, TOOL, { list: `L${index}` }),
      ),
    );
    expect(plans.filter((plan) => plan === "allow")).toHaveLength(1);
    expect(plans.filter((plan) => plan === "ask")).toHaveLength(4);
    expect((run.ctx.state as { tainted: boolean }).tainted).toBe(true);
  });
});

describe("the reminders card", () => {
  const ASK = "Let this bot read your phone's reminders?";

  it("asks one fixed question and shows what it reads as code", () => {
    expect(
      phoneCard("effect-1", TOOL, { ...RANGE, list: "**Home**\n# Allow", include_done: true }, []),
    ).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: ASK,
      detail: `${RANGE.due_from} – ${RANGE.due_to}\n**Home** # Allow\nCompleted too`,
      detailFormat: "code",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(phoneCard("e", TOOL, {}, [])).toEqual(expect.objectContaining({ text: ASK }));
    expect(phoneCard("e", TOOL, {}, [])).not.toHaveProperty("detail");
    expect(phoneCard("e", TOOL, { list: 5 }, [])).toEqual(expect.objectContaining({ text: ASK }));
  });
});

describe("where reminders are offered", () => {
  const offered = async (run: ReturnType<typeof setup>, botDisabled: string[] | null = null) => {
    const off = withoutCloudComputerTools(new Set(), false);
    await offerPhoneTools(
      run.ctx.deps as never,
      run.ctx.run,
      run.ctx.thread,
      "user-1",
      off,
      botDisabled,
    );
    return !off.has(TOOL);
  };

  it("only while the phone declares Reminders, and the bot keeps the tool", async () => {
    expect(isPhoneTool(TOOL)).toBe(true);
    expect(withoutCloudComputerTools(new Set(), false).has(TOOL)).toBe(true);
    expect(await offered(setup({ capabilities: ["reminders"] }))).toBe(true);
    expect(await offered(setup({ capabilities: ["calendar", "reminders-write"] }))).toBe(false);
    expect(await offered(setup(), [TOOL])).toBe(false);
    expect(await offered(setup({ token: true }))).toBe(false);
  });

  it("never in a thread someone else can read", async () => {
    for (const run of [
      setup({ thread: { groupId: "group-1" } }),
      setup({ thread: { externalConversationId: "conversation-1" } }),
      setup({ thread: { helperBotId: "bot-2" } }),
      setup({ otherMember: true }),
    ]) {
      expect(await offered(run)).toBe(false);
      expect(await phoneGate(run.ctx, false, TOOL, {})).toBe("deny");
      expect(await phoneRead(run.ctx, call(TOOL, {}).call)).toHaveProperty("error");
      expect(run.requests).toEqual([]);
    }
  });
});

describe("conversation memory", () => {
  it("keeps a turn that read reminders out of memory", async () => {
    const run = setup({ consent: false });
    expect(await runReadPhone(run.ctx)).toBe(false);
    run.effects.push({ id: "e", runId: "run-1", kind: TOOL, status: "completed" });
    expect(await runReadPhone(run.ctx)).toBe(true);
  });
});
