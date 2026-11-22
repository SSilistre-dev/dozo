import { describe, expect, it, vi } from "vitest";
import {
  lastingWriteNeedsApproval,
  lastingWriteShowsWholeText,
} from "./dozo-lasting-write-approval.js";

describe("lastingWriteNeedsApproval", () => {
  it.each(["skill_create", "skill_update", "skill_delete", "schedule_create", "schedule_update"])(
    "gates %s only once the run is tainted",
    async (name) => {
      await expect(lastingWriteNeedsApproval(name, async () => true)).resolves.toBe(true);
      await expect(lastingWriteNeedsApproval(name, async () => false)).resolves.toBe(false);
    },
  );

  it.each(["skill_read", "schedule_list", "schedule_cancel", "remember", "web_fetch"])(
    "leaves %s alone without checking the run",
    async (name) => {
      const tainted = vi.fn(async () => true);
      await expect(lastingWriteNeedsApproval(name, tainted)).resolves.toBe(false);
      expect(tainted).not.toHaveBeenCalled();
    },
  );
});

describe("lastingWriteShowsWholeText", () => {
  it("covers the lasting writes that carry text", () => {
    for (const name of ["skill_create", "skill_update", "schedule_create", "schedule_update"]) {
      expect(lastingWriteShowsWholeText(name)).toBe(true);
    }
    for (const name of [
      "skill_delete",
      "schedule_cancel",
      "set_child_instructions",
      "send_email",
    ]) {
      expect(lastingWriteShowsWholeText(name)).toBe(false);
    }
  });
});
