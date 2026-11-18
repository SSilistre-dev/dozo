import type { SandboxProvider } from "@rakazo/adapter-kit";
import { sandboxKindCapabilities } from "@rakazo/adapters";
import type { ComputerSize } from "@rakazo/contracts";
import { COMPUTER_SIZE_SPECS } from "@rakazo/contracts";

/**
 * Adds to each tier offer the machine its computer really starts with: what the server's computer
 * provider declares for the size, else the size's usual machine. Clients show this, never a table
 * of their own.
 */
export function withComputerSpecs<Offer extends { computerSize: ComputerSize }>(
  offers: Offer[],
  sandbox: Pick<SandboxProvider, "describe"> | undefined,
) {
  const sizeSpec = sandboxKindCapabilities(sandbox?.describe().id).sizeSpec;
  return offers.map((offer) => ({
    ...offer,
    computerSpec: sizeSpec?.(offer.computerSize) ?? COMPUTER_SIZE_SPECS[offer.computerSize],
  }));
}
