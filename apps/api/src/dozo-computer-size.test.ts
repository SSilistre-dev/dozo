import { sandboxKindCapabilities } from "@rakazo/adapters";
import { COMPUTER_SIZE_SPECS } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withComputerSpecs } from "./dozo-computer-size.js";

// Runs on the branded tree only: the provider declares its sizes once the brand rules are applied.

const offers = [
  { tier: "pro", computerSize: "large" as const },
  { tier: "max", computerSize: "xlarge" as const },
];
const provider = (id: string) => ({ describe: () => ({ id }) }) as never;

afterEach(() => vi.unstubAllEnvs());

describe("withComputerSpecs", () => {
  it("shows the machine the provider starts, from the one setting it starts it with", () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    const shown = withComputerSpecs(offers, provider("docker"));
    expect(shown).toEqual([
      { tier: "pro", computerSize: "large", computerSpec: { vcpus: 2, memoryGb: 2 } },
      { tier: "max", computerSize: "xlarge", computerSpec: { vcpus: 4, memoryGb: 4 } },
    ]);
    for (const offer of shown)
      expect(offer.computerSpec).toEqual(
        sandboxKindCapabilities("docker").sizeSpec?.(offer.computerSize),
      );
  });

  it("keeps the size's usual machine for a size the operator did not set", () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "xlarge=4:4");
    expect(withComputerSpecs(offers, provider("docker")).map((o) => o.computerSpec)).toEqual([
      COMPUTER_SIZE_SPECS.large,
      { vcpus: 4, memoryGb: 4 },
    ]);
  });

  it("keeps the usual machines for a provider with its own, and without a provider", () => {
    vi.stubEnv("RAKAZO_COMPUTER_SIZES", "large=2:2,xlarge=4:4");
    const usual = [COMPUTER_SIZE_SPECS.large, COMPUTER_SIZE_SPECS.xlarge];
    expect(withComputerSpecs(offers, provider("fake")).map((o) => o.computerSpec)).toEqual(usual);
    expect(withComputerSpecs(offers, undefined).map((o) => o.computerSpec)).toEqual(usual);
  });
});
