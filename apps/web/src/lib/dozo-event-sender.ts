import type { DozoClientEvent } from "@rakazo/contracts";

type Client = {
  me(): Promise<{ productEvents?: boolean }>;
  dozoEvents: { track(event: DozoClientEvent): Promise<unknown> };
};

let accepted: Promise<boolean> | undefined;

/**
 * Sends one product event, only to a server that sends them on (`productEvents`). The server is
 * asked once per page load, on the first event; a failed ask is asked again next time. A failed
 * report is measurement lost, never an error shown.
 */
export function sendEvent(client: Client, event: DozoClientEvent): void {
  accepted ??= client.me().then(
    (me) => me.productEvents === true,
    () => {
      accepted = undefined;
      return false;
    },
  );
  void accepted
    .then((on) => (on ? client.dozoEvents.track(event) : undefined))
    .catch(() => undefined);
}

/** Asks the server again on the next event; for tests. */
export function forgetEventServer(): void {
  accepted = undefined;
}
