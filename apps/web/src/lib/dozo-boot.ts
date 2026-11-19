import { authClient } from "./auth";
import { fetchAuthCapabilities } from "./auth-capabilities";
import { initialBootstrapTarget } from "./bootstrap-target";

/** The shell `index.html` draws before any script runs; see `dozo-boot.js` in `public/`. */
const BOOT_SHELL_ID = "dozo-boot";

/**
 * Whether the app has drawn something of its own: a screen, a sign-in form or an error. Until
 * then (empty root, language or session still loading, a whole-page spinner) the shell stays.
 */
export function appHasPainted(root: ParentNode): boolean {
  if (!root.querySelector("*")) return false;
  if (root.querySelector('[data-rakazo-app-state$="-pending"]')) return false;
  return !root.querySelector(
    '[data-rakazo-app-state="ready"] > .place-items-center [data-slot="spinner"]',
  );
}

/**
 * Removes the boot shell in the same frame as the app's first real paint, then calls `released`.
 * A load that never settles must not stay hidden behind it, so it goes after `giveUpMs` anyway.
 */
export function releaseBootShell(
  doc: Document,
  giveUpMs: number,
  released: () => void = () => {},
): void {
  const shell = doc.getElementById(BOOT_SHELL_ID);
  const root = doc.getElementById("root");
  let done = false;
  let observer: MutationObserver | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const release = () => {
    if (done) return;
    done = true;
    observer?.disconnect();
    clearTimeout(timer);
    shell?.remove();
    released();
  };
  if (!shell || !root || appHasPainted(root)) {
    release();
    return;
  }
  observer = new MutationObserver(() => {
    if (appHasPainted(root)) release();
  });
  observer.observe(root, { childList: true, subtree: true });
  timer = setTimeout(release, giveUpMs);
}

/**
 * On a chat route the bootstrap request already starts while modules load. The session and the
 * deployment capabilities do not depend on it, so they start with it instead of after the
 * language catalog and the session.
 */
export function startBootReads(pathname: string, desktop: boolean): boolean {
  if (!initialBootstrapTarget(pathname, desktop)) return false;
  // Listening mounts the session store, which reads the session once; the app subscribes before
  // the answer comes and shares that read. The listener goes with the first answer.
  const session = authClient.$store.atoms.session;
  const stop = session?.listen((state: { isPending: boolean }) => {
    if (!state.isPending) stop?.();
  });
  // Failure clears the cached request, so the subscription gate asks again.
  void fetchAuthCapabilities().catch(() => undefined);
  return true;
}

type BootWindow = Pick<Window, "location" | "setTimeout"> & {
  navigator?: Partial<Navigator> & { connection?: { saveData?: boolean } };
  /** Set by `public/dozo-boot.js`: stops its watch for an app whose code never runs. */
  dozoBootStarted?: () => void;
  requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number;
  rakazoDesktop?: unknown;
};

/**
 * Runs `load` once the browser is idle (or after a short wait where it cannot say), ignoring a
 * failure: the screen loads again when it opens.
 */
export function whenIdle(view: BootWindow, load: () => Promise<unknown>): void {
  const run = () => void load().catch(() => undefined);
  if (view.requestIdleCallback) view.requestIdleCallback(run, { timeout: 5_000 });
  else view.setTimeout(run, 2_000);
}

/** The screens people open most: settings (with billing and models), a new bot, a bot's menu. */
export const loadCommonScreens = () =>
  Promise.all([
    import("../pages/SettingsOverlay"),
    import("../components/bot-templates/bot-templates-dialog"),
    import("../pages/BotContextMenu"),
  ]);

/** Whether someone is signed in, by the session store's last answer. */
function signedIn(): boolean {
  return Boolean(authClient.$store.atoms.session?.get()?.data);
}

/**
 * Once the app has painted a chat route for a signed-in user, its common screens load while the
 * browser is idle, unless the browser asks to save data.
 */
export function boot(view: BootWindow, doc: Document): void {
  view.dozoBootStarted?.();
  const chatRoute = startBootReads(view.location.pathname, Boolean(view.rakazoDesktop));
  releaseBootShell(doc, 10_000, () => {
    if (!chatRoute || view.navigator?.connection?.saveData || !signedIn()) return;
    whenIdle(view, loadCommonScreens);
  });
}

boot(window, document);
