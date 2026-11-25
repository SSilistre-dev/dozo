import { afterEach, describe, expect, it, vi } from "vitest";
import { withoutUnconnectedAgents } from "./dozo-agent-catalog.js";

const AGENT = "codex-agent";
const entries = [
  { provider: AGENT, id: "default" },
  { provider: "openrouter", id: "m" },
];

describe("the catalog's agents", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists an agent only once the person has a connection to it", () => {
    expect(withoutUnconnectedAgents(entries, { byProvider: {}, byModel: {} })).toEqual([
      entries[1],
    ]);
    expect(
      withoutUnconnectedAgents(entries, { byProvider: { [AGENT]: "api-key" }, byModel: {} }),
    ).toEqual(entries);
    expect(
      withoutUnconnectedAgents(entries, {
        byProvider: {},
        byModel: { [AGENT]: { default: "api-key" } },
      }),
    ).toEqual(entries);
  });

  it("leaves every other provider as it was, connected or not", () => {
    expect(withoutUnconnectedAgents([entries[1]!], { byProvider: {}, byModel: {} })).toEqual([
      entries[1],
    ]);
  });

  it("keeps a choice already saved, so a role whose connection was removed still shows its model", () => {
    expect(
      withoutUnconnectedAgents(
        entries,
        { byProvider: {}, byModel: {} },
        new Set([`${AGENT}:default`]),
      ),
    ).toEqual(entries);
    expect(
      withoutUnconnectedAgents(entries, { byProvider: {}, byModel: {} }, new Set(["x:y"])),
    ).toEqual([entries[1]]);
  });

  it("changes nothing on the person's own computer's server", () => {
    vi.stubEnv("HOST_USER_HOME", "/home/person");
    expect(withoutUnconnectedAgents(entries, { byProvider: {}, byModel: {} })).toEqual(entries);
  });
});
