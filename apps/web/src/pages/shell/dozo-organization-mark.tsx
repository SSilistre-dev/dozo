import { cn } from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { desktopBridge, windowChromeKind } from "../../lib/desktop";
import { queryClient, useSpaceQueries } from "../../lib/query";

/** The logo of the organization the open Space belongs to; read again on the roster signal. */
export function useDozoOrganizationMark() {
  const queries = useSpaceQueries();
  return useQuery(queries.dozoOrganizationLogo.mark.queryOptions()).data;
}

/** A logo change reaches every member of the organization's Spaces on the roster signal. */
export function dozoOrganizationMarkChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && path.at(-2) === "dozoOrganizationLogo",
  });
}

/** The logo as a small square tile. The picture is the server's own, so it is safe to show. */
export function DozoOrganizationLogoTile({
  logo,
  name,
  className,
}: {
  logo: string;
  name: string;
  className?: string;
}) {
  return (
    <img
      src={logo}
      alt={name}
      draggable={false}
      className={cn("size-6 shrink-0 rounded-md object-cover ring-1 ring-border", className)}
    />
  );
}

/**
 * The start of the sidebar's header: the window controls a desktop window draws, then the
 * organization's logo when it has one. On the web the controls are only a spacer, which the
 * logo takes the place of. The narrow sidebar shows no logo.
 */
export function DozoSidebarStart({ chrome, mini }: { chrome: ReactNode; mini: boolean }) {
  const mark = useDozoOrganizationMark();
  const logo = mini ? null : mark?.logo;
  if (!logo || !mark) return chrome;
  const spacer = windowChromeKind(desktopBridge()) === "spacer";
  return (
    <div className="me-3 flex min-w-0 items-center gap-3" data-testid="organization-mark">
      {spacer ? null : chrome}
      <DozoOrganizationLogoTile logo={logo} name={mark.name} />
    </div>
  );
}
