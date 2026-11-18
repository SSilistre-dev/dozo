import * as z from "zod";
import type { ComputerSize } from "./computer.js";
import { COMPUTER_SIZE_SPECS } from "./computer.js";

/** The vCPUs and memory a computer really gets, as the server that starts it reports them. */
export const ComputerSizeSpecSchema = z.object({
  vcpus: z.number().positive(),
  memoryGb: z.number().positive(),
});
export type ComputerSizeSpec = z.infer<typeof ComputerSizeSpecSchema>;

/** What a tier's computer provides: the server's answer, or the size's usual one from an older server. */
export function offerComputerSpec(offer: {
  computerSize: ComputerSize;
  computerSpec?: ComputerSizeSpec;
}): ComputerSizeSpec {
  return offer.computerSpec ?? COMPUTER_SIZE_SPECS[offer.computerSize];
}
