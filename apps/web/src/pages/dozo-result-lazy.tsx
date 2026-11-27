import type { ComponentType } from "react";
import { Suspense } from "react";
import { lazyComponent } from "../lib/platform/preload-recovery";

/**
 * The result pages of `dozo-result.tsx` for the upstream pages that use them. The sign-in frame
 * stays out of the startup bundle: each loads on demand and shows nothing while it does.
 */
function onDemand<Props extends object>(load: () => Promise<ComponentType<Props>>) {
  const Page = lazyComponent(load);
  return (props: Props) => (
    <Suspense fallback={null}>
      <Page {...props} />
    </Suspense>
  );
}

export const DozoCallbackResult = onDemand(() =>
  import("./dozo-result").then((module) => module.CallbackResult),
);
export const DozoPageUnavailable = onDemand(() =>
  import("./dozo-result").then((module) => module.PageUnavailable),
);
export const DozoSlackInstallFailed = onDemand(() =>
  import("./dozo-result").then((module) => module.SlackInstallFailed),
);
export const DozoMcpOAuthResult = onDemand(() =>
  import("./dozo-result").then((module) => module.McpOAuthResult),
);
