import { useLingui } from "@lingui/react/macro";
import { announcementText } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { queryClient, useSpaceQueries } from "../lib/query";
import { DozoPastDue } from "./dozo-past-due";

/**
 * The live stream's site-settings signal: whatever shows a site setting reads it again. Only
 * mounted screens refetch.
 */
export function dozoSiteChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) => Array.isArray(path) && path.at(-2) === "dozoSiteSettings",
  });
}

export { announcementText };

/**
 * The signed-in pages, with one line below them for a failed payment and one for the admin's
 * announcement, each only when there is one.
 */
export function DozoAnnouncementLayout() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <DozoPastDue />
      <DozoAnnouncement />
    </div>
  );
}

function DozoAnnouncement() {
  const { i18n } = useLingui();
  // Read once, then again on the live stream's signal (it also signals on every reconnect) and
  // when the window comes back: nothing here is polled.
  const announcement = useQuery({
    ...useSpaceQueries().dozoSiteSettings.announcement.queryOptions(),
    refetchOnWindowFocus: "always",
  });
  const text = announcementText(announcement.data, i18n.locale);
  if (!text) return null;
  return (
    <p
      role="status"
      title={text}
      className="shrink-0 truncate border-t bg-muted px-4 py-1.5 text-center text-body-sm text-muted-foreground"
    >
      {text}
    </p>
  );
}
