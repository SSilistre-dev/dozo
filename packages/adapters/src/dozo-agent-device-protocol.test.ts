import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_DRIVERS } from "./cli-models/dozo-cli-providers.js";
import {
  AGENT_DEVICE_LIMITS,
  AGENT_TURN_DEADLINE_MS,
  agentTurnFrame,
  agentTurnRequest,
} from "./dozo-agent-device-protocol.js";
import { deviceAgentIds, parseDeviceCapabilities } from "./dozo-device-capabilities.js";
import { hostComputerDeadlineMs, hostComputerRequest } from "./host-computer-protocol.js";

/** Examples of the wire format, for the desktop app's own tests to read as well. */
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(new URL(`./dozo-agent-device-fixtures/${name}`, import.meta.url), "utf8"),
  ) as T;
const requests = fixture<{
  valid: Record<string, unknown>[];
  invalid: { why: string; request: Record<string, unknown> }[];
}>("requests.json");
const frames = fixture<{
  valid: Record<string, unknown>[];
  invalid: { why: string; frame: Record<string, unknown> }[];
}>("frames.json");

const turn = {
  method: "agentTurn",
  botId: "bot-1",
  runId: "run-1",
  agent: "codex-agent",
  instructions: "",
  input: "hi",
  tools: [],
};

describe("agent turns over the device connection", () => {
  it("carries each example request as the device protocol reads it", () => {
    for (const request of requests.valid)
      expect(hostComputerRequest.parse(request)).toEqual(request);
  });

  it.each(requests.invalid)("refuses $why", ({ request }) => {
    expect(hostComputerRequest.safeParse(request).success).toBe(false);
  });

  it("gives a whole agent turn its own deadline, and the short requests a computer request's", () => {
    const [first, , result, stop] = requests.valid.map((request) =>
      hostComputerDeadlineMs(hostComputerRequest.parse(request)),
    );
    expect(first).toBe(AGENT_TURN_DEADLINE_MS);
    expect(result).toBe(10 * 60_000);
    expect(stop).toBe(10 * 60_000);
  });

  it("holds a turn to its limits", () => {
    const tool = (name: string, description = "") => ({ name, description, inputSchema: {} });
    const many = Array.from({ length: AGENT_DEVICE_LIMITS.toolCount + 1 }, (_, n) => tool(`t${n}`));
    expect(agentTurnRequest.safeParse({ ...turn, tools: many }).success).toBe(false);
    const big = Array.from({ length: 70 }, (_, n) => tool(`t${n}`, "x".repeat(16 * 1024)));
    expect(agentTurnRequest.safeParse({ ...turn, tools: big }).success).toBe(false);
    const input = "x".repeat(AGENT_DEVICE_LIMITS.input + 1);
    expect(agentTurnRequest.safeParse({ ...turn, input }).success).toBe(false);
    expect(agentTurnRequest.safeParse(turn).success).toBe(true);
  });

  it("reads each example frame the app sends during a turn", () => {
    for (const frame of frames.valid) expect(agentTurnFrame.parse(frame)).toEqual(frame);
  });

  it.each(frames.invalid)("refuses a frame with $why", ({ frame }) => {
    expect(agentTurnFrame.safeParse(frame).success).toBe(false);
  });
});

describe("the agents a computer declares", () => {
  it("are agent mode's own drivers", () => {
    expect(deviceAgentIds().sort()).toEqual(AGENT_DRIVERS.map((driver) => driver.provider).sort());
  });

  it("keeps a known agent after the other capabilities, and drops one it does not know", () => {
    expect(
      parseDeviceCapabilities("agent:Antigravity-Agent, shell,agent:teleport,agent:codex-agent"),
    ).toEqual(["shell", "agent:codex-agent", "agent:antigravity-agent"]);
    expect(parseDeviceCapabilities("agent:,codex-agent")).toEqual([]);
  });
});
