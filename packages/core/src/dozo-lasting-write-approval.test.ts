import { RUN_TRIGGERS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { isOwnerStartedRun } from "./action-approval.js";
import type { LastingWriteRun } from "./dozo-lasting-write-approval.js";
import {
  lastingWriteHoldReason,
  lastingWriteNeedsApproval,
  lastingWriteShowsWholeText,
  ROUTINE_WRITERS,
  routineWriterIsOwner,
  runStartedFromOutside,
} from "./dozo-lasting-write-approval.js";

const run = (trigger: string, facts: Partial<LastingWriteRun> = {}): LastingWriteRun => ({
  trigger,
  ownerStartedRun: isOwnerStartedRun(trigger, false),
  nonOwnerChatRun: false,
  watchFired: false,
  botOwnerRun: true,
  readHistory: false,
  ...facts,
});

/** The routine's last writer, for a routine's run: the owner unless a test says otherwise. */
const ownerRoutine = async () => true;
const outsideRoutine = async () => false;

/** Every trigger a run can have, and whether its input is the owner's own words. */
const OWNER_INPUT: Record<(typeof RUN_TRIGGERS)[number], boolean> = {
  user: true,
  routine: true,
  resume: false,
  // Only a follow-up the owner wrote, below.
  follow_up: false,
  reaction: false,
  call_end: true,
  spawn: false,
  skill: false,
  bot_message: false,
  webhook: false,
  // The owner's own connected chat app; someone else's chat is below.
  messaging: true,
  cloud_agent: false,
  purchase: false,
  media: false,
  created: false,
  tickets: false,
  helper: false,
  helper_result: false,
};

describe("runStartedFromOutside", () => {
  it("pins every run trigger", async () => {
    expect(Object.keys(OWNER_INPUT).sort()).toEqual([...RUN_TRIGGERS].sort());
    for (const trigger of RUN_TRIGGERS) {
      expect([trigger, await runStartedFromOutside(run(trigger), ownerRoutine)]).toEqual([
        trigger,
        !OWNER_INPUT[trigger],
      ]);
    }
  });

  it("counts a follow-up the owner wrote as theirs, and one another bot sent as outside", async () => {
    const owners = run("follow_up", { ownerStartedRun: true });
    expect(await runStartedFromOutside(owners, ownerRoutine)).toBe(false);
    expect(await runStartedFromOutside(run("follow_up"), ownerRoutine)).toBe(true);
  });

  it("counts a message sent with an access token as outside, whatever its trigger", async () => {
    // The run's assembly gives such a message ownerStartedRun false.
    const token = run("user", { ownerStartedRun: false });
    expect(await runStartedFromOutside(token, ownerRoutine)).toBe(true);
  });

  it("counts someone else's connected chat as outside", async () => {
    for (const trigger of ["messaging", "user"]) {
      const chat = run(trigger, { nonOwnerChatRun: true });
      expect(await runStartedFromOutside(chat, ownerRoutine)).toBe(true);
    }
  });

  it("counts a run another member or a guest started as outside, whatever its trigger", async () => {
    for (const trigger of ["user", "follow_up", "call_end", "messaging", "routine"]) {
      const member = run(trigger, { ownerStartedRun: true, botOwnerRun: false });
      expect([trigger, await runStartedFromOutside(member, ownerRoutine)]).toEqual([trigger, true]);
    }
  });

  it("counts a routine a change trigger started as outside: its prompt ends with what it read", async () => {
    const fired = run("routine", { watchFired: true });
    expect(await runStartedFromOutside(fired, ownerRoutine)).toBe(true);
  });

  it("counts a routine as the owner's words only when the owner last wrote it", async () => {
    const routineFromOwner = vi.fn(outsideRoutine);
    expect(await runStartedFromOutside(run("routine"), routineFromOwner)).toBe(true);
    expect(routineFromOwner).toHaveBeenCalledOnce();
    // Other triggers never read the routine's writer.
    routineFromOwner.mockClear();
    await runStartedFromOutside(run("user"), routineFromOwner);
    await runStartedFromOutside(run("webhook"), routineFromOwner);
    expect(routineFromOwner).not.toHaveBeenCalled();
  });

  it("treats a trigger it does not know as outside", async () => {
    expect(await runStartedFromOutside(run("something_new"), ownerRoutine)).toBe(true);
  });
});

describe("routineWriterIsOwner", () => {
  it("counts the owner's own save and the owner's clean run, nothing else", () => {
    expect(ROUTINE_WRITERS).toEqual(["owner", "owner_run", "member", "outside_run"]);
    expect(ROUTINE_WRITERS.filter(routineWriterIsOwner)).toEqual(["owner", "owner_run"]);
  });

  it("counts a routine with no record, or one it does not know, as outside", () => {
    expect(routineWriterIsOwner(undefined)).toBe(false);
    expect(routineWriterIsOwner("something_new")).toBe(false);
  });
});

const LASTING = [
  "skill_create",
  "skill_update",
  "skill_delete",
  "schedule_create",
  "schedule_update",
  "create_child_routine",
];

const checks = (readOutside: boolean, routineFromOwner = ownerRoutine) => ({
  readOutside: async () => readOutside,
  routineFromOwner,
});

describe("lastingWriteNeedsApproval", () => {
  it.each(LASTING)("holds %s in the owner's run once it read outside content", async (name) => {
    await expect(lastingWriteNeedsApproval(name, run("user"), checks(true))).resolves.toBe(true);
    await expect(lastingWriteNeedsApproval(name, run("user"), checks(false))).resolves.toBe(false);
  });

  it.each(LASTING)("holds %s in a run started from outside without asking more", async (name) => {
    const readOutside = vi.fn(async () => false);
    await expect(
      lastingWriteNeedsApproval(name, run("webhook"), {
        readOutside,
        routineFromOwner: ownerRoutine,
      }),
    ).resolves.toBe(true);
    expect(readOutside).not.toHaveBeenCalled();
  });

  it.each(LASTING)(
    "holds %s once the run read its history, whatever else it read",
    async (name) => {
      const history = run("user", { readHistory: true });
      await expect(lastingWriteNeedsApproval(name, history, checks(false))).resolves.toBe(true);
    },
  );

  it("leaves a routine's own run free until it reads outside content", async () => {
    await expect(
      lastingWriteNeedsApproval("schedule_update", run("routine"), checks(false)),
    ).resolves.toBe(false);
    await expect(
      lastingWriteNeedsApproval("schedule_update", run("routine"), checks(true)),
    ).resolves.toBe(true);
  });

  it("holds a routine's own run when someone other than the owner last wrote the routine", async () => {
    await expect(
      lastingWriteNeedsApproval("schedule_update", run("routine"), checks(false, outsideRoutine)),
    ).resolves.toBe(true);
  });

  it.each(["skill_read", "schedule_list", "schedule_cancel", "remember", "web_fetch"])(
    "leaves %s alone without checking the run",
    async (name) => {
      const readOutside = vi.fn(async () => true);
      const routineFromOwner = vi.fn(outsideRoutine);
      const history = run("routine", { readHistory: true, botOwnerRun: false });
      await expect(
        lastingWriteNeedsApproval(name, history, { readOutside, routineFromOwner }),
      ).resolves.toBe(false);
      expect(readOutside).not.toHaveBeenCalled();
      expect(routineFromOwner).not.toHaveBeenCalled();
    },
  );
});

describe("lastingWriteHoldReason", () => {
  it("says history only when the run's input is the owner's and it read nothing from outside", async () => {
    const history = run("user", { readHistory: true });
    await expect(lastingWriteHoldReason("skill_create", history, checks(false))).resolves.toBe(
      "history",
    );
    const routine = run("routine", { readHistory: true });
    await expect(lastingWriteHoldReason("skill_create", routine, checks(false))).resolves.toBe(
      "history",
    );
  });

  it("says outside when the run also read outside content or was started from outside", async () => {
    const history = { readHistory: true };
    for (const [held, facts] of [
      [run("user", history), checks(true)],
      [run("webhook", history), checks(false)],
      [run("user", { ...history, botOwnerRun: false }), checks(false)],
      // A routine someone other than the bot's owner last wrote.
      [run("routine", history), checks(false, outsideRoutine)],
    ] as const) {
      await expect(lastingWriteHoldReason("skill_create", held, facts)).resolves.toBe("outside");
    }
  });

  it("has no reason for a write the rule does not hold", async () => {
    await expect(lastingWriteHoldReason("skill_create", run("user"), checks(false))).resolves.toBe(
      undefined,
    );
    await expect(
      lastingWriteHoldReason("remember", run("webhook", { readHistory: true }), checks(true)),
    ).resolves.toBe(undefined);
  });
});

describe("lastingWriteShowsWholeText", () => {
  it("covers the lasting writes that carry text and have no card of their own", () => {
    for (const name of ["skill_create", "skill_update", "schedule_create", "schedule_update"]) {
      expect(lastingWriteShowsWholeText(name)).toBe(true);
    }
    for (const name of [
      "skill_delete",
      // Its fleet card already shows the whole request, or refuses it.
      "create_child_routine",
      "schedule_cancel",
      "set_child_instructions",
      "send_email",
    ]) {
      expect(lastingWriteShowsWholeText(name)).toBe(false);
    }
  });
});
