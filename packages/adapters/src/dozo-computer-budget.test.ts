import { ClientError } from "@rakazo/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dockerSandboxCapabilities } from "./docker-capabilities.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import {
  COMPUTERS_BUSY_CODE,
  COMPUTERS_BUSY_MESSAGE,
  ComputerCapacityError,
  hostComputerMemory,
  throwIfComputersBusy,
} from "./dozo-computer-budget.js";

// Runs on the branded tree only: the provider and the capability reach this file through anchored
// rules.

const GB = 1024 ** 3;
const env = {
  SANDBOX_SUPERVISOR_TOKEN: "t".repeat(32),
  SANDBOX_SUPERVISOR_URL: "http://sup.test/",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("throwIfComputersBusy", () => {
  it("throws the busy error for a 429 with the supervisor's text", () => {
    const attempt = () => throwIfComputersBusy(429, '{"error":"Computer memory budget reached"}');
    expect(attempt).toThrow(ComputerCapacityError);
    try {
      attempt();
    } catch (error) {
      expect(error).toBeInstanceOf(ClientError);
      expect(error).toMatchObject({
        kind: "TOO_MANY_REQUESTS",
        code: "COMPUTERS_BUSY",
        name: "ComputerCapacityError",
        message: "All computers are busy. Try again shortly.",
      });
    }
  });

  it("holds the literals the supervisor and the clients depend on", () => {
    expect(COMPUTERS_BUSY_MESSAGE).toBe("All computers are busy. Try again shortly.");
    expect(COMPUTERS_BUSY_CODE).toBe("COMPUTERS_BUSY");
    // The supervisor's own constant is asserted in its test, with this same text.
    expect(() => throwIfComputersBusy(429, "Computer memory budget reached")).toThrow(
      ComputerCapacityError,
    );
  });

  it("lets every other refusal through", () => {
    expect(() => throwIfComputersBusy(500, "Computer memory budget reached")).not.toThrow();
    expect(() =>
      throwIfComputersBusy(429, "Computer limit reached for space (max: 3)"),
    ).not.toThrow();
    expect(() => throwIfComputersBusy(429, "")).not.toThrow();
  });
});

describe("hostComputerMemory", () => {
  it("maps bytes to GB and sends the token", async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ usedBytes: 1.5 * GB, budgetBytes: 6 * GB }),
    );
    expect(await hostComputerMemory(env, fetchFn as unknown as typeof fetch)).toEqual({
      usedGb: 1.5,
      totalGb: 6,
    });
    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url).toBe("http://sup.test/computer-memory");
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${env.SANDBOX_SUPERVISOR_TOKEN}`,
    );
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it("is undefined when the supervisor reports no budget", async () => {
    const fetchFn = vi.fn(async () => Response.json({ usedBytes: 2 * GB }));
    expect(await hostComputerMemory(env, fetchFn as unknown as typeof fetch)).toBeUndefined();
  });

  it("asks the default local address when none is set", async () => {
    const fetchFn = vi.fn(async (_url: string, _init: RequestInit) =>
      Response.json({ usedBytes: 0 }),
    );
    await hostComputerMemory(
      { SANDBOX_SUPERVISOR_TOKEN: env.SANDBOX_SUPERVISOR_TOKEN },
      fetchFn as unknown as typeof fetch,
    );
    expect(fetchFn.mock.calls[0]?.[0]).toBe("http://127.0.0.1:7091/computer-memory");
  });

  it("rejects when the supervisor refuses", async () => {
    const fetchFn = vi.fn(async () => new Response("no", { status: 401 }));
    await expect(hostComputerMemory(env, fetchFn as unknown as typeof fetch)).rejects.toThrow(
      "401",
    );
  });
});

describe("the Docker provider", () => {
  it("turns the supervisor's 429 into the busy error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ error: "Computer memory budget reached" }, { status: 429 }),
      ),
    );
    const provider = new DockerSandboxProvider("http://supervisor.test", "token");
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/data/bot" },
        {
          operationId: "o",
          traceId: "t",
          spaceId: "space",
          userId: "user",
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toBeInstanceOf(ComputerCapacityError);
  });

  it("declares the memory read as a capability", () => {
    expect(dockerSandboxCapabilities.memory).toBe(hostComputerMemory);
  });
});
