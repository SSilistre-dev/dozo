import { RUN_TRIGGERS } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { isOwnerStartedRun } from "./action-approval.js";
import type { LastingWriteRun } from "./dozo-lasting-write-approval.js";
import {
  lastingWriteNeedsApproval,
  lastingWriteShowsWholeText,
  runStartedFromOutside,
} from "./dozo-lasting-write-approval.js";

const run = (trigger: string, facts: Partial<LastingWriteRun> = {}): LastingWriteRun => ({
  trigger,
  ownerStartedRun: isOwnerStartedRun(trigger, false),
  nonOwnerChatRun: false,
  watchFired: false,
  ...facts,
});

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
  it("pins every run trigger", () => {
    expect(Object.keys(OWNER_INPUT).sort()).toEqual([...RUN_TRIGGERS].sort());
    for (const trigger of RUN_TRIGGERS) {
      expect([trigger, runStartedFromOutside(run(trigger))]).toEqual([
        trigger,
        !OWNER_INPUT[trigger],
      ]);
    }
  });

  it("counts a follow-up the owner wrote as theirs, and one another bot sent as outside", () => {
    expect(runStartedFromOutside(run("follow_up", { ownerStartedRun: true }))).toBe(false);
    expect(runStartedFromOutside(run("follow_up"))).toBe(true);
  });

  it("counts a message sent with an access token as outside, whatever its trigger", () => {
    // The run's assembly gives such a message ownerStartedRun false.
    expect(runStartedFromOutside(run("user", { ownerStartedRun: false }))).toBe(true);
  });

  it("counts someone else's connected chat as outside", () => {
    expect(runStartedFromOutside(run("messaging", { nonOwnerChatRun: true }))).toBe(true);
    expect(runStartedFromOutside(run("user", { nonOwnerChatRun: true }))).toBe(true);
  });

  it("counts a routine a change trigger started as outside: its prompt ends with what it read", () => {
    expect(runStartedFromOutside(run("routine", { watchFired: true }))).toBe(true);
  });

  it("treats a trigger it does not know as outside", () => {
    expect(runStartedFromOutside(run("something_new"))).toBe(true);
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

describe("lastingWriteNeedsApproval", () => {
  it.each(LASTING)("holds %s in the owner's run once it read outside content", async (name) => {
    await expect(lastingWriteNeedsApproval(name, run("user"), async () => true)).resolves.toBe(
      true,
    );
    await expect(lastingWriteNeedsApproval(name, run("user"), async () => false)).resolves.toBe(
      false,
    );
  });

  it.each(LASTING)("holds %s in a run started from outside without asking more", async (name) => {
    const read = vi.fn(async () => false);
    await expect(lastingWriteNeedsApproval(name, run("webhook"), read)).resolves.toBe(true);
    expect(read).not.toHaveBeenCalled();
  });

  it("leaves a routine's own run free until it reads outside content", async () => {
    await expect(
      lastingWriteNeedsApproval("schedule_update", run("routine"), async () => false),
    ).resolves.toBe(false);
    await expect(
      lastingWriteNeedsApproval("schedule_update", run("routine"), async () => true),
    ).resolves.toBe(true);
  });

  it.each(["skill_read", "schedule_list", "schedule_cancel", "remember", "web_fetch"])(
    "leaves %s alone without checking the run",
    async (name) => {
      const read = vi.fn(async () => true);
      await expect(lastingWriteNeedsApproval(name, run("webhook"), read)).resolves.toBe(false);
      expect(read).not.toHaveBeenCalled();
    },
  );
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
