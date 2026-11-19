import { useLingui } from "@lingui/react/macro";
import type { DozoAnnouncement as Announcement } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { Outlet } from "react-router-dom";
import { useSpaceQueries } from "../lib/query";

/** The text in the app's language, else the one there is. */
export function announcementText(announcement: Announcement | undefined, locale: string) {
  if (!announcement) return null;
  return locale.startsWith("tr")
    ? (announcement.tr ?? announcement.en)
    : (announcement.en ?? announcement.tr);
}

/** The signed-in pages, with the admin's announcement as one line below them when there is one. */
export function DozoAnnouncementLayout() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <DozoAnnouncement />
    </div>
  );
}

export function DozoAnnouncement() {
  const { i18n } = useLingui();
  // Read once, and again whenever the window comes back: nothing here is polled.
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
