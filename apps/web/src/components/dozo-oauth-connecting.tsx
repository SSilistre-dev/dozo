import { Trans } from "@lingui/react/macro";
import { Shimmer } from "./ai/primitives";

/** Replaces the sign-in wait note while a pasted code is being exchanged. */
export function DozoOAuthConnecting() {
  return (
    <Shimmer>
      <Trans>Connecting…</Trans>
    </Shimmer>
  );
}
