import { queryClient } from "./query/query";

// What the app's live stream does when it signals a change of the fork's own data. They sit apart
// from the screens that show the data so the stream's listener, which the app starts with, does not
// bring those screens with it: each screen loads when it is first shown.

/**
 * The live stream's site-settings signal: whatever shows a site setting reads it again. Only
 * mounted screens refetch.
 */
export function dozoSiteChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) => Array.isArray(path) && path.at(-2) === "dozoSiteSettings",
  });
}

/** Reads every open chat's pins again; the roster signal carries a pin change. */
export function dozoPinsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) && path.slice(-2).join(".") === "dozoMessages.pins",
  });
}

/** Reads the pool again; the roster signal carries a pool change. */
export function dozoModelPoolChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: ["dozoModelPool"] });
}
