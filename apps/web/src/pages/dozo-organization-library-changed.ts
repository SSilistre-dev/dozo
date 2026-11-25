import { queryClient } from "../lib/query/query";

/**
 * A library change comes on the roster signal: read the skills and the library again. Apart from
 * the screens that show the library, so the page's first code holds this and not them.
 */
export function dozoOrganizationLibraryChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({
    predicate: ({ queryKey: [path] }) =>
      Array.isArray(path) &&
      (path.at(-2) === "dozoOrganizationLibrary" || path.at(-2) === "agentSkills"),
  });
}
