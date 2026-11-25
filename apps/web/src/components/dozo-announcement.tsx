import { announcementText } from "@rakazo/contracts";
import { Outlet } from "react-router-dom";
import { DozoAnnouncementLines } from "../lib/dozo-lazy-surfaces";

export { dozoSiteChanged } from "../lib/dozo-stream-changed";
export { announcementText };

/**
 * The signed-in pages, with one line below them for a failed payment, one for an address still to
 * verify and one for the admin's announcement, each only when there is one.
 */
export function DozoAnnouncementLayout() {
  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1">
        <Outlet />
      </div>
      <DozoAnnouncementLines />
    </div>
  );
}
