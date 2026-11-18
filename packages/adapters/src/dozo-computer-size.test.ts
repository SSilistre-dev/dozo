import { afterEach, describe, expect, it, vi } from "vitest";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { operatorComputerSize, operatorComputerSizes } from "./dozo-computer-size.js";
import { knownSandboxKinds, sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";

// Runs on the branded tree only: the provider and its capability read the sizes once the brand
// rules are applied.

const context = {
  operationId: "size-test",
  traceId: "size-test",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};

/** The body of the start the provider sends the supervisor for `size`. */
async function startBody(size?: "standard" | "large" | "xlarge") {
  const fetch = vi.fn(async (_url: string, _init: RequestInit) => Response.json({ id: "c1" }));
  vi.stubGlobal("fetch", fetch);
  await new DockerSandboxProvider("http://supervisor.test", "token").provision(
    { botId: "bot", homePath: "/data/bot", size },
    context,
  );
  return JSON.parse(String(fetch.mock.calls[0]?.[1].body));
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("operatorComputerSizes", () => {
  it("maps each size to its vCPUs and memory", () => {
    expect(operatorComputerSizes(" large=2:2 , xlarge=4:4.5,")).toEqual({
      large: { vcpus: 2, memoryGb: 2 },
      xlarge: { vcpus: 4, memoryGb: 4.5 },
    });
  });

  it("sets nothing when the operator sets nothing", () => {
    expect(operatorComputerSizes(undefined)).toEqual({});
    expect(operatorComputerSizes("  ")).toEqual({});
  });

  it.each([
    "huge=2:2",
    "large=2",
    "large=0:2",
    "large=2:0.1",
    "large=2:2g",
    "large=2:2,large=4:4",
    "large",
  ])("refuses %s, naming the variable", (raw) => {
    expect(() => operatorComputerSizes(raw)).toThrow("RAKAZO_COMPUTER_SIZES");
  });
});

describe("sizes on the server's own host", () => {
  it("starts a computer with the vCPUs and memory of the plan's size", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    expect((await startBody("large")).size).toEqual({ vcpus: 2, memoryGb: 2 });
    expect((await startBody("xlarge")).size).toEqual({ vcpus: 4, memoryGb: 4 });
  });

  it("starts at the smaller size once the plan is the smaller one", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    const before = (await startBody("xlarge")).size;
    const after = (await startBody("large")).size;
    expect(after.vcpus).toBeLessThan(before.vcpus);
    expect(after.memoryGb).toBeLessThan(before.memoryGb);
  });

  it("names no size the operator did not set, so the host's one ceiling applies", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2");
    expect(await startBody("standard")).not.toHaveProperty("size");
    expect(await startBody()).not.toHaveProperty("size");
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "");
    expect(await startBody("large")).not.toHaveProperty("size");
  });

  it("declares for the provider exactly what it sends, and for no other provider", async () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    const declared = sandboxKindCapabilities("docker").sizeSpec;
    expect(declared).toBe(operatorComputerSize);
    expect(declared?.("xlarge")).toEqual((await startBody("xlarge")).size);
    expect(knownSandboxKinds.filter((kind) => sandboxKindCapabilities(kind).sizeSpec)).toEqual([
      "docker",
    ]);
  });
});
