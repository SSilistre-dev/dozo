import type * as NodeFsPromises from "node:fs/promises";
import path from "node:path";
import { resolveSupervisorToken } from "@rakazo/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { computerNetworkNameFor, hostComputerUser } from "./computer-spec.js";

// Runs on the branded tree only: the routes reach the budget through anchored brand rules. The
// Docker doubles follow computer-loopback.test.ts.

const GB = 1024 ** 3;

const mocks = vi.hoisted(() => ({
  docker: {
    version: vi.fn(),
    getImage: vi.fn(),
    getContainer: vi.fn(),
    listContainers: vi.fn(),
    createContainer: vi.fn(),
    createNetwork: vi.fn(),
    getNetwork: vi.fn(),
    listNetworks: vi.fn(),
  },
  assertHomeWritable: vi.fn(),
  verifyRestrictedEgress: vi.fn(),
}));
vi.mock("dockerode", () => ({
  default: class {
    version = mocks.docker.version;
    getImage = mocks.docker.getImage;
    getContainer = mocks.docker.getContainer;
    listContainers = mocks.docker.listContainers;
    createContainer = mocks.docker.createContainer;
    createNetwork = mocks.docker.createNetwork;
    getNetwork = mocks.docker.getNetwork;
    listNetworks = mocks.docker.listNetworks;
  },
}));
vi.mock("./home-ownership.js", () => ({ assertComputerHomeWritable: mocks.assertHomeWritable }));
vi.mock("./egress-probe.js", () => ({
  EgressNotEnforced: class EgressNotEnforced extends Error {},
  verifyRestrictedEgress: mocks.verifyRestrictedEgress,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof NodeFsPromises>()),
  mkdir: vi.fn(),
}));

const labels = { "rakazo.managed": "true", "rakazo.botId": "bot", "rakazo.spaceId": "space" };
const IMAGE_ID = "current-image";

/** What the supervisor lists as running: one other bot's computer holding 4 GB. */
let running: { Id: string; Labels: Record<string, string> }[];

function otherComputer() {
  return { Id: "other", Labels: { "rakazo.botId": "other-bot" } };
}

/** The 4 GB computer every request below asks for, against a 6 GB total. */
const size = { vcpus: 1, memoryGb: 4 };

function existingComputer(overrides: { image?: string; running?: boolean } = {}) {
  const info = {
    Image: overrides.image ?? IMAGE_ID,
    Config: { User: hostComputerUser(), Labels: labels },
    HostConfig: {
      Memory: 2 * GB,
      NetworkMode: computerNetworkNameFor("bot"),
      PortBindings: { "7070/tcp": [{ HostIp: "127.0.0.1", HostPort: "0" }] },
    },
    State: { Running: overrides.running ?? false },
    NetworkSettings: {
      Ports: { "6080/tcp": [{ HostIp: "127.0.0.1", HostPort: "1" }] },
      Networks: { [computerNetworkNameFor("bot")]: { NetworkID: "bot-network" } },
    },
  };
  return {
    id: "existing",
    inspect: vi.fn().mockResolvedValue(info),
    start: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
  };
}

/** Docker as the supervisor sees it: the bot's own computer (if any) and the running others. */
function dockerWith(existing?: ReturnType<typeof existingComputer>) {
  const network = { remove: vi.fn().mockResolvedValue(undefined) };
  const created = { id: "new-computer", start: vi.fn(), remove: vi.fn() };
  mocks.docker.getImage.mockReturnValue({ inspect: vi.fn().mockResolvedValue({ Id: IMAGE_ID }) });
  mocks.docker.listContainers.mockImplementation(async (options?: { all?: boolean }) =>
    options?.all ? (existing ? [{ Id: existing.id }] : []) : running,
  );
  mocks.docker.getContainer.mockImplementation((id: string) =>
    id === "other" ? { inspect: async () => ({ HostConfig: { Memory: 4 * GB } }) } : existing,
  );
  mocks.docker.createNetwork.mockResolvedValue(network);
  mocks.docker.listNetworks.mockResolvedValue([]);
  mocks.docker.getNetwork.mockReturnValue({
    inspect: vi.fn().mockResolvedValue({ Id: "bot-network" }),
  });
  mocks.docker.createContainer.mockResolvedValue(created);
  return { network, created };
}

async function start() {
  const { supervisorApp } = await import("./index.js");
  return supervisorApp.request("/computers", {
    method: "POST",
    headers: {
      authorization: `Bearer ${resolveSupervisorToken(process.env)}`,
      "content-type": "application/json",
      "x-rakazo-bot-id": "bot",
      "x-rakazo-space-id": "space",
    },
    body: JSON.stringify({
      botId: "bot",
      spaceId: "space",
      homePath: path.join(process.env.DATA_DIR ?? "", "homes", "bot"),
      size,
    }),
  });
}

const REFUSED = { error: "Computer memory budget reached" };

beforeEach(() => {
  vi.resetModules();
  vi.resetAllMocks();
  mocks.verifyRestrictedEgress.mockResolvedValue(undefined);
  running = [otherComputer()];
  vi.stubEnv("HOSTNAME", "");
  vi.stubEnv("DATA_DIR", "/tmp/dozo-memory-budget-test");
  vi.stubEnv("SANDBOX_SCREEN_NETWORK", "published");
  vi.stubEnv("SANDBOX_SCREEN_HOST", "127.0.0.1");
  vi.stubEnv("SANDBOX_CONTROL_VIA_LOOPBACK", "true");
  vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "6g");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("the memory budget on the start route", () => {
  it("refuses a new computer over the budget with 429, creating nothing and giving the network back", async () => {
    const { network } = dockerWith();
    const response = await start();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(REFUSED);
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("refuses a replacement over the budget without removing the computer it would replace", async () => {
    const existing = existingComputer({ image: "older-image" });
    const { network } = dockerWith(existing);
    const response = await start();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(REFUSED);
    expect(existing.remove).not.toHaveBeenCalled();
    expect(mocks.docker.createContainer).not.toHaveBeenCalled();
    expect(network.remove).toHaveBeenCalledOnce();
  });

  it("refuses a resume over the budget without resizing or starting the computer", async () => {
    const existing = existingComputer();
    dockerWith(existing);
    const response = await start();
    expect(response.status).toBe(429);
    expect(await response.json()).toEqual(REFUSED);
    expect(existing.update).not.toHaveBeenCalled();
    expect(existing.start).not.toHaveBeenCalled();
  });

  it("admits a start that fits after a refusal, so the lock was given back", async () => {
    const { created } = dockerWith();
    expect((await start()).status).toBe(429);
    running = [];
    const response = await start();
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ id: "new-computer", resumed: false });
    expect(created.start).toHaveBeenCalledOnce();
  });

  it("resizes and starts a resume that fits", async () => {
    const existing = existingComputer();
    dockerWith(existing);
    running = [];
    const response = await start();
    expect(response.status).toBe(200);
    expect(existing.update).toHaveBeenCalledOnce();
    expect(existing.start).toHaveBeenCalledOnce();
  });

  it("starts the same over-budget computer when no total is set", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_MEMORY_TOTAL", "");
    const { created } = dockerWith();
    const response = await start();
    expect(response.status).toBe(200);
    expect(created.start).toHaveBeenCalledOnce();
    // Only the lookup of the bot's own computer asks Docker for a list: no count was made.
    expect(
      mocks.docker.listContainers.mock.calls.filter(([options]) => !options?.all),
    ).toHaveLength(0);
  });
});
