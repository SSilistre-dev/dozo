import { describe, expect, it } from "vitest";
import { askActionLabel } from "./ask-action-label";
import { dozoAlwaysAllowLabel, dozoRunAllowLabel } from "./dozo-ask-label";

describe("the approval card's Always allow on a command", () => {
  it("names the command, not the tool", () => {
    expect(
      askActionLabel({ id: "always", label: "Always allow this command" }, { approval: true }),
    ).toBe("Always allow this command");
    expect(
      askActionLabel({ id: "always", label: "Always allow this tool" }, { approval: true }),
    ).toBe("Always allow this tool");
    expect(
      askActionLabel(
        { id: "always", label: "Always allow this command" },
        { approval: true, site: "example.com" },
      ),
    ).toBe("Always allow example.com");
  });

  it("reads only the server's command label", () => {
    expect(dozoAlwaysAllowLabel("Always allow this command")).toBe("Always allow this command");
    expect(dozoAlwaysAllowLabel("Allow once")).toBeUndefined();
  });
});

describe("the approval card's Allow for this run", () => {
  it("names the run, and nothing else answers with it", () => {
    expect(
      askActionLabel({ id: "allow_run", label: "Allow for this run" }, { approval: true }),
    ).toBe("Allow for this run");
    expect(dozoRunAllowLabel("allow_run")).toBe("Allow for this run");
    expect(dozoRunAllowLabel("allow")).toBeUndefined();
  });
});
