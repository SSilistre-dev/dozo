/**
 * The live run's fence: which RPC calls it lets through. No imports, so Node's test runner checks
 * it offline against the contracts (`canli-fence.test.mjs`, run by `make olc`): every procedure of
 * the fenced namespaces must be listed here as a read or a write, so a procedure added to the
 * contract fails `make olc` until someone classifies it. The contracts carry no read/write mark
 * (every RPC is a POST), so the lists are the one place that says it. At run time a procedure in
 * neither list is refused, the safe side.
 */

/** Namespaces whose calls an admin or an account changing thing could make. */
export const FENCED_NAMESPACES = ["dozoAdmin", "dozoSiteSettings", "accessGrants", "marketplace"];

/** Procedures that only read; the admin pages call them when they open. */
export const READS = new Set([
  "dozoAdmin/users",
  "dozoAdmin/user",
  "dozoAdmin/computers",
  "dozoAdmin/bans",
  "dozoAdmin/billing/summary",
  "dozoAdmin/billing/revenue",
  "dozoAdmin/funnel/read",
  "dozoAdmin/plans/list",
  "dozoSiteSettings/get",
  "dozoSiteSettings/announcement",
  "accessGrants/list",
  "marketplace/catalog",
  "marketplace/submissions",
]);

/** Procedures that change something: refused on the live run, whoever is signed in. */
export const WRITES = new Set([
  "dozoAdmin/rename",
  "dozoAdmin/endSessions",
  "dozoAdmin/setSuspended",
  "dozoAdmin/setPlan",
  "dozoAdmin/ban",
  "dozoAdmin/unban",
  "dozoAdmin/deleteUser",
  "dozoAdmin/stopComputer",
  "dozoAdmin/plans/setQuota",
  "dozoAdmin/accessGrants/update",
  "dozoAdmin/accessGrants/delete",
  "dozoSiteSettings/update",
  "accessGrants/create",
  "accessGrants/revoke",
  "marketplace/review",
]);

/** Outside the fenced namespaces, these change billing and are refused too. */
const OTHER_WRITES = new Set(["billing/portal"]);

export type FenceVerdict = { pass: boolean; reason: string };

/** What the fence does with a request to `pathname` (`/rpc/<procedure>`). */
export function fenceVerdict(pathname: string): FenceVerdict {
  if (!pathname.startsWith("/rpc/")) return { pass: true, reason: "not an RPC" };
  const procedure = pathname.slice("/rpc/".length).replace(/\/+$/, "");
  if (OTHER_WRITES.has(procedure)) return { pass: false, reason: `${procedure} changes billing` };
  const namespace = procedure.split("/")[0] ?? "";
  if (!FENCED_NAMESPACES.includes(namespace)) return { pass: true, reason: "outside the fence" };
  if (READS.has(procedure)) return { pass: true, reason: "a read" };
  if (WRITES.has(procedure)) return { pass: false, reason: `${procedure} changes something` };
  return {
    pass: false,
    reason: `unknown procedure ${procedure}: if it only reads, add it to READS in dozo/e2e/canli/fence.ts`,
  };
}

/**
 * Network errors of this machine, not of the site: the test browser shares the host's network,
 * which changes whenever a container starts or stops. Only these are worth one more try.
 */
export function isNetworkFlap(message: string): boolean {
  return /net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED)\b/.test(message);
}
