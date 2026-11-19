import type { ServiceWorkerScope } from "./service-worker";
import { installServiceWorker as upstreamInstallServiceWorker } from "./service-worker";

type FetchEvent = {
  request: Request;
  clientId?: string;
  resultingClientId?: string;
  respondWith(response: Promise<Response>): void;
};

/**
 * How long a request may go unanswered before a cached copy answers it instead. A request that
 * hangs (no answer, no error) would otherwise never reach the cache and leave the page blank.
 */
export const NETWORK_WAIT_MS = 4000;

type Settled = { response: Response } | { error: unknown };

/**
 * The network's answer, or after `NETWORK_WAIT_MS` the copy `cached` finds, when there is one;
 * without a copy it keeps waiting for the network. A network failure rejects as before.
 */
export async function networkUnlessHung(
  scope: Pick<ServiceWorkerScope, "fetch">,
  request: Request,
  cached: () => Promise<Response | undefined>,
): Promise<Response> {
  const network = scope.fetch(request).then(
    (response): Settled => ({ response }),
    (error: unknown): Settled => ({ error }),
  );
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Response | undefined>((resolve) => {
    timer = setTimeout(() => resolve(cached()), NETWORK_WAIT_MS);
  });
  const first = await Promise.race([network, late]);
  clearTimeout(timer);
  if (first instanceof Response) return first;
  const settled = first ?? (await network);
  if ("error" in settled) throw settled.error;
  return settled.response;
}

/**
 * Upstream's worker, except that hashed assets come from the network first, which the browser
 * answers from its HTTP cache, where the server marks them immutable: reading them from the
 * worker's cache first made every warm load slower. The worker's cache answers when the network
 * fails or hangs for `NETWORK_WAIT_MS`, and first for a page it opened from the cached shell while
 * offline. A navigation that hangs that long gets upstream's offline answer, the cached shell.
 * The shell, the theme and updates keep upstream's behaviour.
 */
export function installServiceWorker(
  scope: ServiceWorkerScope,
  precache: readonly string[],
  cacheName: string,
): void {
  const precached = new Set(precache);
  // Window clients whose navigation failed, so the cached shell was what they got.
  const offlinePages = new Set<string>();
  const navigations = new WeakMap<Request, string>();

  const shell = {
    location: scope.location,
    caches: scope.caches,
    clients: scope.clients,
    get registration() {
      return scope.registration;
    },
    skipWaiting: () => scope.skipWaiting(),
    fetch: (request: Request) => {
      const page = navigations.get(request);
      const answer =
        request.mode === "navigate"
          ? // A hung navigation fails while a shell is cached, so upstream answers with that shell.
            networkUnlessHung(scope, request, async () => {
              if (await scope.caches.match("/")) throw new Error("navigation hung");
              return undefined;
            })
          : scope.fetch(request);
      return answer.catch((error: unknown) => {
        if (page) offlinePages.add(page);
        throw error;
      });
    },
    addEventListener: (type: string, listener: (event: never) => void) => {
      if (type !== "fetch") {
        scope.addEventListener(type as "install", listener as never);
        return;
      }
      scope.addEventListener("fetch", (event) => {
        const { request, clientId = "", resultingClientId = "" } = event as FetchEvent;
        if (request.mode === "navigate") {
          if (resultingClientId) navigations.set(request, resultingClientId);
        } else if (networkFirst(request) && !offlinePages.has(clientId)) {
          const cached = () => scope.caches.match(request);
          (event as FetchEvent).respondWith(
            networkUnlessHung(scope, request, cached).catch(async (error: unknown) => {
              const copy = await cached();
              if (copy) return copy;
              throw error;
            }),
          );
          return;
        }
        listener(event as never);
      });
    },
  };

  function networkFirst(request: Request): boolean {
    if (request.method !== "GET") return false;
    const url = new URL(request.url);
    if (url.origin !== scope.location.origin) return false;
    return precached.has(url.pathname) || url.pathname.startsWith("/assets/");
  }

  upstreamInstallServiceWorker(shell as unknown as ServiceWorkerScope, precache, cacheName);
}
