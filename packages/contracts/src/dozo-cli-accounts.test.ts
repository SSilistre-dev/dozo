import { describe, expect, it } from "vitest";
import { DozoCliToolSchema } from "./dozo-cli-accounts.js";

const tool = {
  provider: "agent-a",
  name: "Agent A",
  mode: "agent",
  found: false,
  signedIn: null,
  connected: false,
  canAdd: false,
};

describe("a tool's download page", () => {
  it("is optional and, when there, an https address", () => {
    expect(DozoCliToolSchema.safeParse(tool).success).toBe(true);
    expect(
      DozoCliToolSchema.safeParse({ ...tool, downloadUrl: "https://agent.example/get" }).success,
    ).toBe(true);
    for (const bad of ["http://agent.example", "javascript:alert(1)", "//agent.example", "agent"])
      expect(DozoCliToolSchema.safeParse({ ...tool, downloadUrl: bad }).success).toBe(false);
  });
});
