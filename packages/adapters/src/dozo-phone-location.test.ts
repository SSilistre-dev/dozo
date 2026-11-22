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
  PHONE_LOCATION_NOTE,
  phoneCard,
  phoneGate,
  phoneRead,
  runReadPhone,
} from "./dozo-phone.js";
import type { Answer } from "./dozo-phone.test-support.js";
import { answers, call, failing, setup as phoneSetup } from "./dozo-phone.test-support.js";
import { PHONE_LOCATION_TOOL } from "./dozo-phone.tool-definition.js";
import { phoneLocationValue } from "./dozo-phone-protocol.js";

const TOOL = PHONE_LOCATION_TOOL;
const AT = "2026-11-22T10:00:00.000Z";
/** Where the phone is, more exactly than the bot may see it unasked. */
const FIX = {
  latitude: 41.008237,
  longitude: 28.978358,
  accuracyMeters: 12,
  precise: true,
  at: AT,
};
const APPROXIMATE = {
  latitude: 41.01,
  longitude: 28.98,
  accuracyMeters: 1000,
  precise: false,
  at: AT,
};

const setup = (
  options: Omit<Parameters<typeof phoneSetup>[0], "answer" | "tool"> & { answer?: Answer } = {},
) => phoneSetup({ tool: TOOL, answer: answers(FIX), ...options });

async function locate(run: ReturnType<typeof setup>, args: Record<string, unknown> = {}) {
  const plan = await phoneGate(run.ctx, false, TOOL, args);
  const made = call(TOOL, args);
  return { plan, ...made, result: await phoneRead(run.ctx, made.call) };
}

afterEach(() => {
  logged.length = 0;
  vi.restoreAllMocks();
});

describe("an approximate location", () => {
  it("is the default, rounded here again whatever the phone sends, and kept as read only", async () => {
    const run = setup();
    const { plan, result, persisted } = await locate(run);
    expect(plan).toBe("allow");
    expect(run.requests).toEqual([
      {
        owner: "user-1",
        deviceId: "phone-1",
        request: {
          method: "phoneLocation",
          botId: "bot-1",
          runId: "run-1",
          precision: "approximate",
        },
      },
    ]);
    expect(run.devices.connectedPhone).toHaveBeenCalledWith("user-1", "location");
    expect(result).toEqual(APPROXIMATE);
    expect(persisted).toEqual([{ read: true, note: PHONE_LOCATION_NOTE }]);
    for (const secret of ["41.0", "28.9", "41", "28"]) {
      expect(JSON.stringify(persisted)).not.toContain(secret);
      expect(JSON.stringify(logged)).not.toContain(secret);
    }
  });

  it("rounds to two decimals and at least a kilometre", () => {
    expect(phoneLocationValue({ ...FIX, accuracyMeters: 5000 }, "approximate")).toEqual({
      ...APPROXIMATE,
      accuracyMeters: 5000,
    });
    expect(
      phoneLocationValue({ ...FIX, latitude: -0.001, longitude: -179.996 }, "approximate"),
    ).toMatchObject({ latitude: 0, longitude: -180 });
  });

  it("follows the owner's consent: the first read asks, later ones do not", async () => {
    expect(await phoneGate(setup({ consent: false }).ctx, false, TOOL, {})).toBe("ask");
    expect(await phoneGate(setup().ctx, false, TOOL, { precision: "approximate" })).toBe("allow");
    expect(await phoneGate(setup({ tainted: true }).ctx, false, TOOL, {})).toBe("ask");
  });
});

describe("a precise location", () => {
  it("is passed on in full only when the phone gave it", async () => {
    const run = setup();
    run.effects.push({
      id: "e",
      runId: "run-1",
      kind: TOOL,
      status: "approved",
      request: { precision: "precise" },
    });
    const { plan, result } = await locate(run, { precision: "precise" });
    expect(plan).toBe("allow");
    expect(run.requests[0]?.request).toHaveProperty("precision", "precise");
    expect(result).toEqual(FIX);
    // The user allowed only approximate on the phone: rounded here too.
    expect(phoneLocationValue({ ...FIX, precise: false }, "precise")).toEqual(APPROXIMATE);
  });

  it("asks every time: no earlier read or card carries over", async () => {
    const run = setup();
    run.effects.push(
      {
        id: "p",
        runId: "run-0",
        kind: TOOL,
        status: "completed",
        request: { precision: "precise" },
      },
      { id: "a", runId: "run-1", kind: TOOL, status: "approved", request: {} },
      {
        id: "q",
        runId: "run-1",
        kind: TOOL,
        status: "completed",
        request: { precision: "precise" },
      },
    );
    expect(await phoneGate(run.ctx, false, TOOL, { precision: "precise" })).toBe("ask");
    expect(run.findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { status: "approved", runId: "run-1", request: { equals: { precision: "precise" } } },
          ],
        }),
      }),
    );
    // A precise call the user did not approve reads nothing.
    expect(
      await phoneRead(run.ctx, call(TOOL, { precision: "precise" }, true).call),
    ).toHaveProperty("error", expect.stringContaining("changed"));
    expect(run.requests).toEqual([]);
  });

  it("says so on its card", () => {
    expect(phoneCard("effect-1", TOOL, { precision: "precise" }, [])).toEqual({
      kind: "ask",
      approvalEffectId: "effect-1",
      text: "Let this bot see your phone's precise location?",
      status: "pending",
      actions: [
        { id: "allow", label: "Allow" },
        { id: "deny", label: "Deny" },
      ],
    });
    expect(phoneCard("e", TOOL, {}, [])).toHaveProperty(
      "text",
      "Let this bot see your phone's approximate location?",
    );
    expect(phoneCard("e", TOOL, { precision: "exact" }, [])).toHaveProperty(
      "text",
      "Let this bot see your phone's location?",
    );
  });
});

describe("a location read", () => {
  it("refuses a precision it does not know, before the phone", async () => {
    const run = setup();
    const { plan, result } = await locate(run, { precision: "exact" });
    expect(plan).toBe("allow");
    expect(result).toEqual({ error: 'precision must be "approximate" or "precise".' });
    expect(run.requests).toEqual([]);
  });

  it("tells the model an unreadable answer", async () => {
    for (const answer of [{ ...FIX, latitude: 200 }, { ...FIX, at: "now" }, "here"]) {
      const run = setup({ answer: answers(answer) });
      expect((await locate(run)).result).toEqual({
        error: "The user's phone could not read its location.",
      });
    }
    expect(phoneLocationValue(null, "approximate")).toBeNull();
  });

  it.each([
    ["location-off", "turn on Location in the app's Phone settings"],
    ["location-permission", "turn on Location in the app's Phone settings"],
    ["location-unavailable", "could not read its location"],
    ["contacts-off", "could not read its location"],
  ])("maps the phone's %s to one sentence, logging only its kind", async (code, says) => {
    const run = setup({ answer: failing(new Error(code)) });
    const { result } = await locate(run);
    expect((result as { error: string }).error).toContain(says);
    expect(logged).toEqual([
      ["warn", "phone location read failed", { kind: code === "contacts-off" ? "other" : code }],
    ]);
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

  it("is uncertain when its record cannot be kept, without the place", async () => {
    const run = setup();
    const args = {};
    await phoneGate(run.ctx, false, TOOL, args);
    const made = call(TOOL, args);
    vi.mocked(made.call.persistEffectResult).mockResolvedValueOnce(false);
    const result = await phoneRead(run.ctx, made.call);
    expect(result).toHaveProperty("uncertain", true);
    expect(JSON.stringify(result)).not.toContain("41.0");
  });
});

describe("where the location is offered", () => {
  it("only while the phone declares Location, in a thread only the owner reads", async () => {
    const offered = async (run: ReturnType<typeof setup>) => {
      const off = withoutCloudComputerTools(new Set(), false);
      await offerPhoneTools(
        run.ctx.deps as never,
        run.ctx.run,
        run.ctx.thread,
        "user-1",
        off,
        null,
      );
      return !off.has(TOOL);
    };
    expect(isPhoneTool(TOOL)).toBe(true);
    expect(await offered(setup())).toBe(true);
    expect(await offered(setup({ capabilities: ["calendar", "contacts"] }))).toBe(false);
    expect(await offered(setup({ otherMember: true }))).toBe(false);
    const group = setup({ thread: { groupId: "group-1" } });
    expect(await offered(group)).toBe(false);
    expect(await phoneGate(group.ctx, false, TOOL, {})).toBe("deny");
    expect(await phoneRead(group.ctx, call(TOOL, {}).call)).toHaveProperty("error");
    expect(group.requests).toEqual([]);
  });

  it("keeps a turn that read the location out of memory", async () => {
    const run = setup({ consent: false });
    run.effects.push({ id: "e", runId: "run-1", kind: TOOL, status: "intended" });
    expect(await runReadPhone(run.ctx)).toBe(true);
  });
});
