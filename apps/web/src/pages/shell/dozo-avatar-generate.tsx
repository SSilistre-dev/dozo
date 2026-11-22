import { Trans } from "@lingui/react/macro";
import { TabsTrigger } from "@rakazo/ui-web";
import { QueryClientContext, useQuery } from "@tanstack/react-query";
import { useContext } from "react";
import { useSpaceQueries } from "../../lib/query";

/** The studio tab that holds the description field and the picture drawn from it. */
export const DOZO_AVATAR_GENERATE_TAB = "generate";

/**
 * Whether this server can draw an avatar from a description for this person. Read when the studio
 * opens and again after each picture, never polled. Without a query client (a page that renders the
 * studio bare) or while the read is out or failed, it is not on offer.
 */
function useAvatarGenerateAvailable(): boolean {
  const queries = useSpaceQueries();
  const status = useQuery(queries.dozoAvatarGenerate.status.queryOptions());
  return status.data?.available === true;
}

function WithStatus({ children }: { children: (available: boolean) => React.ReactNode }) {
  return children(useAvatarGenerateAvailable());
}

export function WhenQueriesExist({
  children,
}: {
  children: (available: boolean) => React.ReactNode;
}) {
  return useContext(QueryClientContext) ? <WithStatus>{children}</WithStatus> : null;
}

/** The third way beside Bot and Upload; absent unless drawing is on offer. */
export function DozoAvatarGenerateTab() {
  return (
    <WhenQueriesExist>
      {(available) =>
        available ? (
          <TabsTrigger value={DOZO_AVATAR_GENERATE_TAB} className="rounded-full px-3 text-label">
            <Trans>Generate</Trans>
          </TabsTrigger>
        ) : null
      }
    </WhenQueriesExist>
  );
}
