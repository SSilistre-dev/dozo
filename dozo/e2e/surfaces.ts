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
    reason:
      "desktop app only (the shortcuts dialog lists Find in chat only for the Electron host); the desktop app is out of scope here",
  },
  {
    what: "tool-call cards other than an approval (ask, secret ask, sub-agent), artifact viewer, shared pages",
    reason:
      "the offline model calls a tool only when a scenario asks it to (flows: one approval); no bot makes a file, so /app/artifacts/:id and /p/:slug are scanned with unknown ids only",
  },
  {
    what: "voice calls and dictation",
    reason:
      "no voice provider is configured; the Voice settings page is scanned, a call is not started",
  },
  {
    what: "connecting a real integration, messaging app or OAuth provider",
    reason: "needs the third-party service; the catalogs, forms and callback pages are scanned",
  },
  {
    what: "accepting an invite as a second person, passkeys, social sign-in buttons",
    reason:
      "a second account would spend more of the 10 credential calls per 15 minutes; WebAuthn and social providers need devices or accounts that are not on this stack",
  },
  {
    what: "a real payment provider, paywall, wallet, messaging and computer provider settings",
    reason:
      "the billing, wallet and messaging providers are not configured: billing's screens are scenarios with the server's answers faked in the browser (flows/billing.spec.ts) and the payment page is make canli's; the other pages are opened with their flags faked, so only their own copy is scanned",
  },
  { what: "mobile app", reason: "out of scope (Expo app)" },
];

export const SURFACES: Surface[] = [...signedOut, ...appSurfaces, ...settings, ...languages];
