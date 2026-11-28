import { activeThreadRuns } from "@rakazo/core";
import { useQuery } from "@tanstack/react-query";
import { router } from "expo-router";
import { useEffect, useRef } from "react";
import type { MobileSnapshot } from "./api/mobile-types";
import {
  revisableRead,
  setDozoEditOpener,
  setDozoReplayOpener,
  setDozoReportOpener,
  useDozoPins,
} from "./dozo-message-actions";
import { queryClient } from "./query/query";

setDozoEditOpener((threadId, messageId) =>
  router.push({ pathname: "/dozo-edit-message", params: { threadId, messageId } }),
);
setDozoReplayOpener((messageId) =>
  router.push({ pathname: "/dozo-replay", params: { messageId } }),
);
setDozoReportOpener((threadId, messageId) =>
  router.push({ pathname: "/dozo-feedback", params: { threadId, messageId } }),
);

/**
 * Called once by the open chat: reads what Edit and Regenerate apply to again whenever the newest
 * message or a run changes, and the pins on every roster signal.
 */
export function useDozoThreadMenus(snap: MobileSnapshot | null, readOnly: boolean): void {
  const threadId = snap?.threadId;
  const revisable = Boolean(threadId) && !readOnly && !snap?.groupId;
  const last = snap?.messages.at(-1);
  const runs = activeThreadRuns(snap)
    .map((run) => `${run.id}:${run.status}`)
    .join(",");
  const version = `${last?.id}:${last?.blocks.length}:${runs}`;
  useQuery(
    { ...revisableRead(threadId ?? ""), enabled: revisable, staleTime: Infinity },
    queryClient,
  );
  useDozoPins(threadId);
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    if (revisable && threadId)
      void queryClient.invalidateQueries({ queryKey: revisableRead(threadId).queryKey });
  }, [version, revisable, threadId]);
}
