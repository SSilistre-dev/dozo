import { describe, expect, it } from "vitest";
import {
  connectorReadRequiresApproval,
  isOwnerStartedRun,
  planActionGate,
} from "./runs/action-approval.js";

// What the meeting prep template relies on: its runs are started by a routine, which upstream counts
// as the owner's run, and a calendar read after outside content came in (what the calendar returns
// is outside content) must still not wait for a person. The
// seeded executor run that checks the same through the real gate is in the pull request notes.

describe("a routine run reading the calendar", () => {
  const unruled = {
    decision: "allow" as const,
    source: "default" as const,
    matchingRules: [],
    decisiveRules: [],
  };
  const read = (mode: "never" | "auto" | "ask", checkerConfigured = true) =>
    planActionGate({
      resolved: unruled,
      mode,
      consequential: false,
      reviewOnly: connectorReadRequiresApproval({ tainted: true, connectorTrusted: false }),
      checkerConfigured,
    });

  it("reads the calendar as a run that took in outside content", () => {
    expect(isOwnerStartedRun("routine", false)).toBe(true);
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: false })).toBe(true);
    // Reads after the first one, on the same app, are free.
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: true })).toBe(false);
  });

  it("runs the read in Ask and Never ask, and only has the approval model judge it in Auto", () => {
    expect(read("ask")).toBe("allow");
    expect(read("never")).toBe("allow");
    expect(read("auto")).toBe("judge");
    expect(read("auto", false)).toBe("allow");
  });

  it("never needs a person for the read unless a rule says to ask", () => {
    const ask = planActionGate({
      resolved: { ...unruled, decision: "ask", source: "require_approval" },
      mode: "ask",
      consequential: false,
      reviewOnly: true,
      checkerConfigured: true,
    });
    expect(ask).toBe("ask");
  });
});
