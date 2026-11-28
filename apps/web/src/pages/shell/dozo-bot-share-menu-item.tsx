import { Trans } from "@lingui/react/macro";
import { ContextMenuItem } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { Link2 } from "lucide-react";
import { useSpaceQueries } from "../../lib/query/query";
import { openDozoSurface } from "../dozo-surfaces";
import type { DozoBotMenuItemProps } from "./dozo-bot-extensions";

/** Share link, for the bot's owner only: the server refuses anyone else's status read. */
export function DozoBotShareMenuItem({ botId, onClose }: DozoBotMenuItemProps) {
  const queries = useSpaceQueries();
  const status = useQuery({
    ...queries.dozoBotShares.status.queryOptions({ input: { botId } }),
    retry: false,
  });
  if (!status.isSuccess) return null;
  return (
    <ContextMenuItem
      onClick={() => {
        onClose();
        openDozoSurface("bot-share", { botId });
      }}
    >
      <Link2 />
      <Trans>Share link</Trans>
    </ContextMenuItem>
  );
}
