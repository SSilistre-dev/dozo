import { SandboxAllowanceUsedError } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import type { HostComputerRequest } from "./host-computer-protocol.js";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { userComputerShell } from "./run-tools-user-computer.js";
import type { UserDeviceGateway } from "./user-device-protocol.js";

/**
 * Dozo's Free plan has no hosted computer: its allowance is zero, so starting the bot's own
 * computer is refused. A member's own paired computer is what Free offers instead, so nothing on
 * that path may consult the plan, the allowance or the bot's computer.
 */
describe("Free plan and the member's own computer", () => {
  it("runs a command on the paired computer while the hosted computer is refused", async () => {
    const refused = () => {
      throw new SandboxAllowanceUsedError();
    };
    // Any read of the hosted computer, the database or billing fails the test.
    const untouchable = new Proxy({}, { get: refused });
    const requests: HostComputerRequest[] = [];
    const gateway: UserDeviceGateway = {
      connected: async () => ({ deviceId: "device-1", name: "Laptop", platform: "linux" }),
      pairedSince: async () => new Date(0),
      async *request<T>(_userId: string, request: HostComputerRequest) {
        requests.push(request);
        if (request.method === "environment")
          yield { platform: "linux", home: "/home/member", shell: "/bin/sh" } as T;
        else if (request.method === "execute") {
          yield { type: "stdout", data: "merhaba\n" } as T;
          yield { type: "exit", code: 0 } as T;
        } else yield {} as T;
      },
    };
    const ctx = {
      deps: { userDevices: gateway, prisma: untouchable, billing: untouchable },
      computer: untouchable,
      bot: { id: "bot-1" },
      runId: "run-1",
      source: { userComputerOwner: "member-1" },
      context: { signal: new AbortController().signal },
      secrets: [],
    } as unknown as RunContext;
    const call = {
      name: "user_computer_shell",
      args: { command: "echo merhaba" },
      finish: async (result: unknown) => result,
    } as unknown as ToolCall;

    const result = (await userComputerShell(ctx, call)) as { output?: string; exitCode?: number };

    expect(JSON.stringify(result)).toContain("merhaba");
    expect(requests.map((request) => request.method)).toEqual([
      "provision",
      "environment",
      "execute",
    ]);
    expect(requests[2]).toMatchObject({
      command: { argv: ["/bin/sh", "-lc", "echo merhaba"], cwd: "/home/member" },
    });
  });
});
