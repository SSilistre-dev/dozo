import type { ComponentProps } from "react";
import { DozoLocalModels } from "../dozo-local-models";
import { ModelStep as UpstreamModelStep } from "./model-step";

/**
 * Upstream's model step with the local-model panel under it. The page derives its step from the
 * account (`needsModel`), so once a model is connected a reload of /onboarding moves on to the first
 * bot, the same way upstream's credits path continues.
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
