import { describe, expect, it } from "vitest";
import { BillingStatusSchema } from "./billing.js";
import { COMPUTER_SIZE_SPECS } from "./computer.js";
import { offerComputerSpec } from "./dozo-computer-size.js";

// Runs on the branded tree only: the offer carries `computerSpec` once the brand rules are applied.

describe("offerComputerSpec", () => {
  it("shows what the server reports, not the size's usual machine", () => {
    expect(
      offerComputerSpec({ computerSize: "large", computerSpec: { vcpus: 2, memoryGb: 2 } }),
    ).toEqual({ vcpus: 2, memoryGb: 2 });
  });

  it("falls back to the size's usual machine for a server that reports none", () => {
    expect(offerComputerSpec({ computerSize: "large" })).toEqual(COMPUTER_SIZE_SPECS.large);
  });

  it("travels in the billing status' tier offers", () => {
    const offer = {
      tier: "pro",
      name: "Premium",
      monthlyPriceCents: 100,
      annualPriceCents: null,
      computerSize: "large",
      computerHours: 100,
    };
    const tiers = BillingStatusSchema.shape.byokTiers;
    expect(tiers.parse([{ ...offer, computerSpec: { vcpus: 2, memoryGb: 2 } }])?.[0]).toMatchObject(
      { computerSpec: { vcpus: 2, memoryGb: 2 } },
    );
    expect(tiers.parse([offer])?.[0]?.computerSpec).toBeUndefined();
    expect(() => tiers.parse([{ ...offer, computerSpec: { vcpus: 0, memoryGb: 2 } }])).toThrow();
  });
});
