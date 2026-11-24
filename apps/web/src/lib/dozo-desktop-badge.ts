import { useEffect } from "react";
import { useDesktopBadge as useBridgeBadge } from "./use-desktop-badge";

/** The colour a title ends with in the desktop app, as ` #0e0e10`: see `useDesktopFrameColour`. It
 * goes last so that an older app, which reads the count from the start of the title, still does. */
const COLOUR_SUFFIX = / #[0-9a-f]{6}$/i;
/** The count a title starts with, as `titleWithCount` writes it: `(3) Dozo`. */
const COUNT_PREFIX = /^\(\d+\) /;

/** The title with the unread count in front, or without one when nothing is unread. Only the
 * number: no chat or bot name ever goes into the title. */
export function titleWithCount(title: string, count: number): string {
  const colour = title.match(COLOUR_SUFFIX)?.[0] ?? "";
  const bare = title.slice(0, title.length - colour.length).replace(COUNT_PREFIX, "");
  return (Number.isFinite(count) && count >= 1 ? `(${Math.floor(count)}) ${bare}` : bare) + colour;
}

/** A `theme-color` as the `#rrggbb` the shell reads, or null for anything else (`#fff` too). */
export function frameColour(content: string | null | undefined): string | null {
  const hex = content?.trim().match(/^#([0-9a-f]{6}|[0-9a-f]{3})$/i)?.[1];
  if (!hex) return null;
  const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
  return `#${full.toLowerCase()}`;
}

/** The title with the frame colour at the end, or without one when there is none. */
export function titleWithColour(title: string, colour: string | null): string {
  const bare = title.replace(COLOUR_SUFFIX, "");
  return colour ? `${bare} ${colour}` : bare;
}

/**
 * The unread badge. Upstream's desktop app takes it over its bridge; the fork's own desktop
 * shell has no bridge into the page and reads the count from the title instead, as a browser
 * tab shows it. The title is cleared again when the shell goes.
 */
export function useDesktopBadge(count: number) {
  useBridgeBadge(count);
  useDesktopFrameColour();
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

/**
 * The window's frame follows the theme. The shell has no bridge into the page and reads the title
 * only, so the page's own `theme-color` (its applied background, which `applyResolvedAppearance`
 * keeps current) goes at the end of it as `#rrggbb`. Only in the desktop app's window: a browser
 * tab never has it. Cleared with the count when the shell goes.
 */
function useDesktopFrameColour() {
  useEffect(() => {
    // Set by the desktop app's window (`dozo-desktop-app.tsx`); not imported, to keep that
    // component out of the startup code.
    if (window.dozoDesktopShell !== true) return;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (!meta) return;
    const put = () => {
      document.title = titleWithColour(document.title, frameColour(meta.getAttribute("content")));
    };
    put();
    const watch = new MutationObserver(put);
    watch.observe(meta, { attributes: true, attributeFilter: ["content"] });
    return () => {
      watch.disconnect();
      document.title = titleWithColour(document.title, null);
    };
  }, []);
}
