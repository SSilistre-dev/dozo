import { DozoCacheSavings } from "./dozo-cache-savings";
import { PlanUsage as UpstreamPlanUsage } from "./PlanUsage";

/** Settings > Usage's allowances and credits, then this period's cache share. */
export function PlanUsage() {
  return (
    <>
      <UpstreamPlanUsage />
      <DozoCacheSavings />
    </>
  );
}
