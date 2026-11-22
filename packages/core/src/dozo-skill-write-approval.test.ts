import { describe, expect, it, vi } from "vitest";
import { skillWriteNeedsApproval } from "./dozo-skill-write-approval.js";

describe("skillWriteNeedsApproval", () => {
  it.each(["skill_create", "skill_update"])(
    "gates %s only once the run is tainted",
    async (name) => {
      await expect(skillWriteNeedsApproval(name, async () => true)).resolves.toBe(true);
      await expect(skillWriteNeedsApproval(name, async () => false)).resolves.toBe(false);
    },
  );

  it.each(["skill_read", "skill_delete", "remember", "web_fetch"])(
    "leaves %s alone without checking the run",
    async (name) => {
      const tainted = vi.fn(async () => true);
      await expect(skillWriteNeedsApproval(name, tainted)).resolves.toBe(false);
      expect(tainted).not.toHaveBeenCalled();
    },
  );
});
