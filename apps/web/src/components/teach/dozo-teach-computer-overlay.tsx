import { planHasNoComputer } from "@rakazo/contracts";
import type { ComponentProps } from "react";
import { useBilling } from "../SubscriptionGate";
import { TeachComputerOverlayControl as UpstreamControl } from "./TeachComputerOverlay";

/** Upstream's Teach control in the computer header, hidden on a plan with no computer. */
export function TeachComputerOverlayControl(props: ComponentProps<typeof UpstreamControl>) {
  if (planHasNoComputer(useBilling().status)) return null;
  return <UpstreamControl {...props} />;
}
