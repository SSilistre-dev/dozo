import type { UserDeviceSummary } from "@rakazo/contracts";
import { ClientError } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cliHomeConnection, readCliTools } from "./dozo-cli-accounts.js";
import { cliAccountRef } from "./dozo-cli-driver.js";
import { DEVICE_OFFLINE_ERROR } from "./dozo-device-agent.js";

const AGENT = "antigravity-agent";

/** Ada's paired computers and what each declared; Bob's list is empty. */
function hosted(
  over: {
    devices?: UserDeviceSummary[];
    declared?: Record<string, string[]>;
    stored?: Array<{ provider: string; secretId: string; plaintext: string }>;
  } = {},
) {
  const devices = over.devices ?? [
    { deviceId: "dev-1", name: "Laptop", connected: true },
    { deviceId: "dev-2", name: "Desktop", connected: true },
    { deviceId: "dev-3", name: "Old Mac", connected: false },
    { deviceId: "dev-4", name: "Work PC", connected: true },
  ];
  const declared = over.declared ?? {
    "dev-1": [`agent:${AGENT}`, "shell"],
    "dev-2": [`agent:${AGENT}`],
    "dev-3": [`agent:${AGENT}`],
    // Connected, but its app never declared an agent: the flag in its app is off.
    "dev-4": ["shell", "screen"],
  };
  const stored = over.stored ?? [];
  return {
    billingEnabled: true,
    prisma: {
      user: { count: async () => 2 },
      userDevice: {
        findMany: async ({ where }: { where: { userId: string } }) =>
          where.userId === "ada"
            ? devices.map((device) => ({
                id: device.deviceId,
                name: device.name,
                connections: device.connected ? [{ deviceId: device.deviceId }] : [],
              }))
            : [],
      },
      userModelCredential: {
        findMany: async ({ where }: { where: { userId: string; provider: { in: string[] } } }) =>
          stored
            .filter((row) => where.provider.in.includes(row.provider))
            .map((row) => ({ provider: row.provider, secretId: row.secretId })),
      },
      secret: {
        findFirst: async ({ where }: { where: { id: string } }) => ({
          id: where.id,
          ciphertext: where.id,
        }),
      },
      $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) =>
        strings.join("?").includes("dozo_device_capabilities")
          ? [{ capabilities: declared[String(values[0])] ?? [] }]
          : [],
    } as unknown as PrismaClient,
    secretStore: {
      load: async (_ciphertext: string, id: string) =>
        stored.find((row) => row.secretId === id)?.plaintext ?? "",
    },
  };
}

describe("settings on a hosted server", () => {
  it("offers an agent once for each connected computer that runs it, named for both", async () => {
    const tools = await readCliTools(hosted(), "ada");
    const rows = tools.filter((tool) => tool.provider === AGENT && tool.found);
    expect(rows).toEqual([
      {
        provider: AGENT,
        name: "Antigravity · Laptop",
        mode: "agent",
        found: true,
        signedIn: null,
        connected: false,
        canAdd: false,
        deviceId: "dev-1",
      },
      expect.objectContaining({ name: "Antigravity · Desktop", deviceId: "dev-2" }),
    ]);
  });

  it("shows nothing for an offline computer, nor for one that does not declare the agent", async () => {
    const tools = await readCliTools(hosted(), "ada");
    expect(tools.map((tool) => tool.deviceId)).not.toContain("dev-3");
    expect(tools.map((tool) => tool.deviceId)).not.toContain("dev-4");
    // With no computer running one, there is no row at all.
    const none = await readCliTools(
      hosted({ declared: { "dev-1": ["shell"], "dev-2": [], "dev-3": [], "dev-4": [] } }),
      "ada",
    );
    expect(none).toEqual([]);
  });

  it("shows another person's computers to no one but its owner", async () => {
    expect(await readCliTools(hosted(), "bob")).toEqual([]);
  });

  it("marks the computers the person already connected", async () => {
    const tools = await readCliTools(
      hosted({
        stored: [
          {
            provider: AGENT,
            secretId: "s1",
            plaintext: cliAccountRef({ kind: "device", deviceId: "dev-2" }),
          },
          // A stored key or a home reference is not a computer.
          { provider: AGENT, secretId: "s2", plaintext: "dozo-cli-account:home" },
        ],
      }),
      "ada",
    );
    expect(
      tools.filter((tool) => tool.found).map((tool) => [tool.deviceId, tool.connected]),
    ).toEqual([
      ["dev-1", false],
      ["dev-2", true],
    ]);
  });
});

describe("connecting an agent on a computer", () => {
  it("stores which computer, named for both, and never a credential", async () => {
    expect(await cliHomeConnection(hosted(), "ada", AGENT, { deviceId: "dev-2" })).toMatchObject({
      provider: AGENT,
      label: "Antigravity · Desktop",
      plaintext: "dozo-cli-account:device:dev-2",
    });
  });

  it("names an agent that takes the catalog's models, and one that chooses its own", async () => {
    const codex = await cliHomeConnection(
      hosted({ declared: { "dev-1": ["agent:codex-agent"] } }),
      "ada",
      "codex-agent",
      { deviceId: "dev-1" },
    );
    expect(codex).toMatchObject({
      label: "Codex \u00b7 Laptop",
      plaintext: "dozo-cli-account:device:dev-1",
    });
    expect(codex.modelId).not.toBe("default");
    expect((await cliHomeConnection(hosted(), "ada", AGENT, { deviceId: "dev-1" })).modelId).toBe(
      "default",
    );
  });

  it.each([
    ["an offline computer", "dev-3"],
    ["one that does not declare the agent", "dev-4"],
    ["one that is not paired", "dev-9"],
  ])("refuses %s", async (_name, deviceId) => {
    await expect(cliHomeConnection(hosted(), "ada", AGENT, { deviceId })).rejects.toThrow(
      DEVICE_OFFLINE_ERROR,
    );
  });

  it("refuses someone else's computer", async () => {
    await expect(cliHomeConnection(hosted(), "bob", AGENT, { deviceId: "dev-1" })).rejects.toThrow(
      DEVICE_OFFLINE_ERROR,
    );
  });

  it("refuses a computer that is already connected", async () => {
    const connected = hosted({
      stored: [
        {
          provider: AGENT,
          secretId: "s1",
          plaintext: cliAccountRef({ kind: "device", deviceId: "dev-1" }),
        },
      ],
    });
    const error = await cliHomeConnection(connected, "ada", AGENT, { deviceId: "dev-1" }).catch(
      (failure: unknown) => failure,
    );
    expect(error).toBeInstanceOf(ClientError);
    expect((error as Error).message).toContain("already connected");
  });
});

describe("on the person's own computer's server", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("lists no computer's agent and refuses to connect one, whatever usableHost says", async () => {
    // The desktop app's server, with a second person on it: its tools are off, and its runtime
    // runs no agent on another computer.
    vi.stubEnv("HOST_USER_HOME", "/home/person");
    expect(await readCliTools(hosted(), "ada")).toEqual([]);
    await expect(cliHomeConnection(hosted(), "ada", AGENT, { deviceId: "dev-1" })).rejects.toThrow(
      "cannot be used on this server",
    );
  });
});
