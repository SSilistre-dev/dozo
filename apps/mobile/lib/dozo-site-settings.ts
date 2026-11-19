import { announcementText } from "@rakazo/contracts";
import { queryClient, rpcQuery } from "./query";

const ANNOUNCEMENT = "dozoSiteSettings/announcement";

/** The admin's announcement, read in the selected Space's scope like every other read. */
export function announcementQuery() {
  return rpcQuery(ANNOUNCEMENT);
}

/** The live stream's site-settings signal: whatever shows the announcement reads it again. */
export function dozoSiteChanged(): Promise<void> {
  return queryClient.invalidateQueries({
    predicate: ({ queryKey }) => queryKey.includes(ANNOUNCEMENT),
  });
}

export { announcementText };
