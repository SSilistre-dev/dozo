// Pure decisions of the e2e suite, kept apart so Node's own test runner can check them offline
// (logic.test.mjs, run by `make olc`): no imports, no Playwright. Types only; Node strips them.

/**
 * True when the path of `url` (a full URL or a path) matches a router pattern as the app's router
 * reads it: `:name` is one non-empty segment, `:name?` an optional last one, `*` anything. Literal
 * segments and a trailing slash are compared the router's way (case-insensitive, slash-tolerant).
 */
export function matchesRoute(pattern: string, url: string): boolean {
  if (pattern === "*") return true;
  let path: string;
  try {
    path = new URL(url, "http://localhost").pathname;
  } catch {
    return false;
  }
  const split = (text: string) => text.split("/").filter((part) => part !== "");
  const want = split(pattern);
  const have = split(path);
  const last = want[want.length - 1];
  const optionalLast = last !== undefined && last.startsWith(":") && last.endsWith("?");
  if (have.length !== want.length && !(optionalLast && have.length === want.length - 1)) {
    return false;
  }
  return have.every((segment, i) => {
    const part = want[i] as string;
    return part.startsWith(":") || part.toLowerCase() === segment.toLowerCase();
  });
}

/** Where a key really ends up when that is not its own pattern (a redirect), with the reason. */
export type LandsOn = Record<string, { path: string; reason: string }>;

/**
 * The `route:` keys among `covers` that no visited URL reached: a surface that passed `reach` but
 * never showed the route it declares did not visit it. A key is reached when some visited URL
 * matches its own pattern, or the pattern `landsOn` names for it. Other key kinds are not judged.
 */
export function routeKeysMissed(
  covers: string[],
  visited: string[],
  landsOn: LandsOn = {},
): string[] {
  return covers.filter((key) => {
    if (!key.startsWith("route:")) return false;
    const patterns = [key.slice("route:".length)];
    const override = landsOn[key];
    if (override) patterns.push(override.path);
    return !visited.some((url) => patterns.some((pattern) => matchesRoute(pattern, url)));
  });
}

/**
 * The coverage reporter's rule that a declared key nobody visited fails the run. Only judged when
 * every surface ran: a filtered run cannot have visited the rest.
 */
export function declaredKeysVerdict(
  ranAll: boolean,
  declared: Iterable<string>,
  visited: ReadonlySet<string>,
): { checked: boolean; unvisited: string[] } {
  if (!ranAll) return { checked: false, unvisited: [] };
  const unvisited = [...new Set(declared)].filter((key) => !visited.has(key)).sort();
  return { checked: true, unvisited };
}
