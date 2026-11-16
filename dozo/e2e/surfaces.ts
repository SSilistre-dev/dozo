import type { Surface } from "./fixtures";
import { appSurfaces } from "./surfaces/app";
import { languages } from "./surfaces/languages";
import { settings } from "./surfaces/settings";
import { signedOut } from "./surfaces/signed-out";

/**
 * The crawl, as data. Each surface says how to reach a screen (and what to open on it); the runner
 * scans every reached state for the upstream name, links and copied text. `covers` ties a surface to
 * the inventory of routes, settings sections and overlays that inventory.ts reads from the app's own
 * source: an upstream that adds one fails inventory.spec.ts until it is covered here or skipped.
 * The lists live in surfaces/*.ts.
 */

/** Inventory keys deliberately not visited, each with the reason. Printed in the coverage report. */
export const SKIPS: Record<string, string> = {
  "settings:updates":
    "desktop app only: the section needs the Electron update bridge (desktopBridge().update), which a browser never has",
};

/** Things a person could meet that this stack cannot show, and why. Printed in the coverage report. */
export const NOT_REACHABLE: { what: string; reason: string }[] = [
  {
    what: "e-mails (sign-up, verification, reset, invite, welcome)",
    reason:
      "no mail server is configured (no SMTP or provider variables on the api; forgot-password answers 'Password recovery is not configured'), so none is sent or logged; the templates are only covered by the static brand gate",
  },
  {
    what: "Find in chat, window chrome, desktop update",
    reason: "desktop app only (the shortcuts dialog lists Find in chat only for the Electron host); the desktop app is out of scope here",
  },
  {
    what: "tool-call cards (ask, approval, secret ask, sub-agent, tool activity), artifact viewer, shared pages",
    reason: "the offline model answers with text only, so no bot ever calls a tool or makes a file; /app/artifacts/:id and /p/:slug are scanned with unknown ids only",
  },
  {
    what: "voice calls and dictation",
    reason: "no voice provider is configured; the Voice settings page is scanned, a call is not started",
  },
  {
    what: "connecting a real integration, messaging app or OAuth provider",
    reason: "needs the third-party service; the catalogs, forms and callback pages are scanned",
  },
  {
    what: "accepting an invite as a second person, passkeys, social sign-in buttons",
    reason: "a second account would spend more of the 10 credential calls per 15 minutes; WebAuthn and social providers need devices or accounts that are not on this stack",
  },
  {
    what: "admin pages with real data, billing, paywall, wallet, messaging and computer provider settings",
    reason: "RAKAZO_ADMIN_EMAILS and the billing, wallet and messaging providers are not configured; the pages are opened with those flags faked in the browser, so only their own copy is scanned",
  },
  { what: "mobile app", reason: "out of scope (Expo app)" },
];

export const SURFACES: Surface[] = [...signedOut, ...appSurfaces, ...settings, ...languages];
