import { useEffect } from "react";
import { useDesktopBadge as useBridgeBadge } from "./use-desktop-badge";

/** The count a title starts with, as `titleWithCount` writes it: `(3) Dozo`. */
const COUNT_PREFIX = /^\(\d+\) /;

/** The title with the unread count in front, or without one when nothing is unread. Only the
 * number: no chat or bot name ever goes into the title. */
export function titleWithCount(title: string, count: number): string {
  const bare = title.replace(COUNT_PREFIX, "");
  return count > 0 ? `(${Math.floor(count)}) ${bare}` : bare;
}

/**
 * The unread badge. Upstream's desktop app takes it over its bridge; the fork's own desktop
 * shell has no bridge into the page and reads the count from the title instead, as a browser
 * tab shows it. The title is cleared again when the shell goes.
 */
export function useDesktopBadge(count: number) {
  useBridgeBadge(count);
  useEffect(() => {
    document.title = titleWithCount(document.title, count);
  }, [count]);
  useEffect(
    () => () => {
      document.title = titleWithCount(document.title, 0);
    },
    [],
  );
}
