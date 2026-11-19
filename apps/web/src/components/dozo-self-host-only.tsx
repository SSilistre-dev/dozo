import type { ReactNode } from "react";
import { useBilling } from "./SubscriptionGate";

/**
 * Shows its children on a deployment that does not bill, so self-hosters keep what is written for
 * running their own server, and the hosted service (which bills) leaves it out.
 */
export function DozoSelfHostOnly({ children }: { children: ReactNode }) {
  return useBilling().status ? null : children;
}
