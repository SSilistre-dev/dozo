import type { ComponentProps } from "react";
import { DozoLocalModels } from "../dozo-local-models";
import { ModelStep as UpstreamModelStep } from "./model-step";

/**
 * Upstream's model step with the local-model panel under it. The reload stays: the page reads `me`
 * once on mount with a direct `rpc.me` call, not a query (Onboarding.tsx:41-51), so invalidating the
 * `me` read cannot move it on; its only way forward is `goTo("bot")`, reachable through the
 * `onConnected` closure handed to `useOnboardingModel` (Onboarding.tsx:29-33), which this step is not
 * given (`OnboardingModel` does not return it). Upstream's credits path reloads the same way
 * (use-onboarding-model.ts:263), and the reload re-derives the step from `needsModel`.
 */
export function ModelStep(props: ComponentProps<typeof UpstreamModelStep>) {
  return (
    <>
      <UpstreamModelStep {...props} />
      <div className="mt-6">
        <DozoLocalModels onConnected={() => window.location.assign("/onboarding")} />
      </div>
    </>
  );
}
