import { describe, expect, it } from "vitest";
import { createSandboxProvider } from "./computers/sandbox/sandbox-factory.js";

// Runs on the branded tree (`make qa`): the brand rules add the check to sandbox-factory.ts.

const ctx = {
  operationId: "test",
  traceId: "test",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
};

const incus = {
  incusUrl: "https://incus.example.test:8443",
  incusClientCert: "test-cert",
  incusClientKey: "test-key",
};

describe("a provider that would run upstream's computer image", () => {
  it.each([
    ["kubernetes", {}, "KUBERNETES_SANDBOX_COMPUTER_IMAGE"],
    ["incus", incus, "INCUS_SANDBOX_COMPUTER_IMAGE"],
    ["local-vm", {}, "LOCAL_VM_COMPUTER_IMAGE"],
  ] as const)(
    "keeps %s computers unavailable and names the image setting",
    async (kind, opts, setting) => {
      const sandbox = await createSandboxProvider(kind, opts);
      expect(sandbox.describe().id).toBe("none");
      await expect(sandbox.provision({ botId: "b", homePath: "/tmp" }, ctx)).rejects.toThrow(
        `${setting} is required for SANDBOX_PROVIDER=${kind}`,
      );
    },
  );

  it("starts with an image built from this tree", async () => {
    const image = "registry.example.test/dozo/computer:1";
    expect(
      (await createSandboxProvider("kubernetes", { kubernetesComputerImage: image })).describe().id,
    ).toBe("kubernetes");
    expect(
      (await createSandboxProvider("incus", { ...incus, incusComputerImage: image })).describe().id,
    ).toBe("incus");
  });
});
