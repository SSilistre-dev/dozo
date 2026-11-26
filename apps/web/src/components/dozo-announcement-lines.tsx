import { useLingui } from "@lingui/react/macro";
import { announcementText } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useSpaceQueries } from "../lib/query/query";
import { DozoPastDue } from "./dozo-past-due";
import { DozoVerifyReminder } from "./dozo-verify-reminder";

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

/**
 * The lines below the signed-in pages: one for a failed payment, one for an address still to
 * verify and one for the admin's announcement, each only when there is one. Loaded after the page,
 * since most of the time none of them shows.
 */
export function DozoAnnouncementLines() {
  return (
    <>
      <DozoPastDue />
      <DozoVerifyReminder />
      <DozoAnnouncement />
    </>
  );
}
