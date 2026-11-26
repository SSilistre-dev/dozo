import { bestEffort } from "@rakazo/logging/best-effort";
import type { PluginsOverlay } from "./plugins/PluginsOverlay";

let loading: Promise<typeof PluginsOverlay> | undefined;

/** Fetches the integrations overlay's code once; a failed fetch is tried again on the next call. */
export function preloadPluginsOverlay(): Promise<typeof PluginsOverlay> {
  loading ??= import("./plugins/PluginsOverlay").then(
    (module) => module.PluginsOverlay,
    (error: unknown) => {
      loading = undefined;
      throw error;
    },
  );
  return loading;
}

/** For the shell settling, or a pointer or focus arriving on a control that opens the overlay. */
export function warmPluginsOverlay() {
  // Opening the overlay fetches it again and shows the failure there.
  void bestEffort("preload the Apps overlay", preloadPluginsOverlay());
}
