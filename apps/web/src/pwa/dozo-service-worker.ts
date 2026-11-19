import type { ServiceWorkerScope } from "./service-worker";
import { installServiceWorker as upstreamInstallServiceWorker } from "./service-worker";

type FetchEvent = {
  request: Request;
  clientId?: string;
  resultingClientId?: string;
  respondWith(response: Promise<Response>): void;
};

/**
 * Upstream's worker, except that hashed assets come from the network first, which the browser
 * answers from its HTTP cache, where the server marks them immutable: reading them from the
 * worker's cache first made every warm load slower. The worker's cache answers when the network
 * fails, and first for a page it opened from the cached shell while offline. Navigations, the
 * shell, the theme and updates keep upstream's behaviour.
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
    fetch: (request: Request) =>
      scope.fetch(request).catch((error: unknown) => {
        const page = navigations.get(request);
        if (page) offlinePages.add(page);
        throw error;
      }),
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
          (event as FetchEvent).respondWith(
            scope.fetch(request).catch(async (error: unknown) => {
              const cached = await scope.caches.match(request);
              if (cached) return cached;
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
