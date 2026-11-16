import { useQuery } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { DozoLocalModels } from "./dozo-local-models";
import { ModelSettingsOverlay as UpstreamModelSettingsOverlay } from "./ModelSettingsOverlay";

/** The local-model panel for the account page: it keeps a current main model and fills an empty one. */
function AccountLocalModels() {
  const rpc = useSpaceRpc();
  const queries = useSpaceQueries();
  // The read the page above already holds: same key, so it is not fetched a second time. Until it
  // has arrived the current model is unknown, and an unknown one is kept.
  const me = useQuery({
    queryKey: queries.me.queryKey(),
    queryFn: () => rpc.me(),
    refetchOnMount: false,
  }).data;
  return (
    <div className="mt-6">
      <DozoLocalModels scope="account" makeDefault={me ? !me.defaultModel : false} />
    </div>
  );
}

/**
 * Upstream's model settings with the local-model panel under its content. The panel only joins the
 * account's embedded page: a dialog would leave it outside the frame, and a Space shows no connections.
 * A connect refreshes the model lists through `useSave`, which the settings page reads from the cache.
 */
export function ModelSettingsOverlay(props: ComponentProps<typeof UpstreamModelSettingsOverlay>) {
  return (
    <>
      <UpstreamModelSettingsOverlay {...props} />
      {props.embedded && props.scope === "account" ? <AccountLocalModels /> : null}
    </>
  );
}
