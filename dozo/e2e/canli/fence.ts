/**
 * The live run's fence: which RPC calls it lets through, and which network failures it tries
 * again (guardFlaps, below). No imports, so Node's test runner checks
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
  return /net::ERR_(NETWORK_CHANGED|INTERNET_DISCONNECTED|QUIC_PROTOCOL_ERROR)\b/.test(message);
}

/** How many times one scenario reloads its page after a flap broke one of the page's requests. */
export const FLAP_RELOADS = 2;

/** The part of Playwright's page and request the flap guard uses (a fake one in the test). */
type FailedRequest = {
  url(): string;
  method(): string;
  failure(): { errorText: string } | null;
  isNavigationRequest(): boolean;
  frame(): unknown;
};
type FlapPage = {
  on(event: "requestfailed", listener: (request: FailedRequest) => void): unknown;
  mainFrame(): unknown;
  goto(url: string, options?: never): Promise<unknown>;
  reload(): Promise<unknown>;
};
type FlapHooks = {
  /** Keeps the scenario's watcher from counting this exact failure line: it was retried. */
  allow(line: RegExp): void;
  /** A line in the report's Notlar, so no retry is hidden. */
  note(text: string): void;
  wait(ms: number): Promise<void>;
};

/** A pattern that matches this one watcher line and nothing else. */
function exactLine(line: string) {
  const escaped = line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}$`);
}

/**
 * A page that meets this machine's own network flap is tried again. Its document (`page.goto`,
 * `page.reload`) is retried at most twice per call; a script, style, image or call of the page that
 * fails with a flap reloads the page, at most FLAP_RELOADS times per scenario, and the failures of
 * the same flap before that reload starts ride on it. Every retry adds a note. The site's own
 * failures (4xx/5xx, a refused or timed-out connection, wrong content) are never retried, and a
 * flap past the cap fails the scenario (`settled`).
 */
export function guardFlaps(page: FlapPage, hooks: FlapHooks) {
  let reloads = 0;
  let queued = false;
  let gaveUp: string | undefined;
  let documentLine: string | undefined;
  let reloading: Promise<void> = Promise.resolve();
  let broken: unknown;

  async function retried<T>(open: () => Promise<T>, what: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await open();
      } catch (error) {
        const message = String(error);
        if (attempt >= 2 || !isNetworkFlap(message)) throw error;
        if (documentLine) hooks.allow(exactLine(documentLine));
        const flap = message.match(/net::ERR_\w+/)?.[0];
        hooks.note(`ağ koptu (${flap}): ${what} yeniden denendi (${attempt + 1}/2)`);
        await hooks.wait(500 * (attempt + 1));
      }
    }
  }

  page.on("requestfailed", (request) => {
    const error = request.failure()?.errorText ?? "failed";
    if (!isNetworkFlap(error)) return;
    const url = new URL(request.url());
    const line = `failed: ${error} ${request.method()} ${url.host}${url.pathname}`;
    if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
      documentLine = line;
      return;
    }
    if (queued) return hooks.allow(exactLine(line));
    if (reloads >= FLAP_RELOADS) {
      if (gaveUp) return;
      hooks.note(
        `ağ yine koptu (${error}, ${url.pathname}): ${FLAP_RELOADS} yeniden yüklemeden sonra vazgeçildi`,
      );
      // An earlier retry let this very line through, so the watcher alone may not count it.
      gaveUp = line;
      return;
    }
    reloads++;
    queued = true;
    hooks.allow(exactLine(line));
    hooks.note(
      `ağ koptu (${error}, ${url.pathname}): sayfa yeniden yüklendi (${reloads}/${FLAP_RELOADS})`,
    );
    const pause = 500 * reloads;
    reloading = reloading
      .then(async () => {
        await hooks.wait(pause);
        queued = false;
        await retried(() => page.reload(), "yeniden yükleme");
      })
      .catch((error: unknown) => {
        broken ??= error;
      });
  });

  const goto = page.goto.bind(page);
  page.goto = (url, options) => retried(() => goto(url, options), `${url} açılışı`);

  return {
    /** Waits for a reload still under way; throws when it failed or the network flapped past the cap. */
    async settled() {
      await reloading;
      if (broken) throw broken;
      if (gaveUp)
        throw new Error(
          `this machine's network flapped again after ${FLAP_RELOADS} reloads: ${gaveUp}`,
        );
    },
  };
}
