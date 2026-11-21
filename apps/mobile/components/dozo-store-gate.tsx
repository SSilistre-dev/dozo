import { Redirect } from "expo-router";
import type { ReactNode } from "react";
import { storeBuild } from "../lib/dozo-store-build";

/** A purchase screen (Billing, the paywall): in the store build a link to it lands on the chats. */
export function DozoStoreGate({
  children,
  store = storeBuild,
}: {
  children: ReactNode;
  store?: boolean;
}) {
  return store ? <Redirect href="/" /> : children;
}
