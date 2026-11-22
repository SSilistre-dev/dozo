import type { ComponentProps, ReactNode } from "react";
import { Suspense } from "react";
import { ErrorBoundary, SectionLoadFailed } from "../components/ErrorBoundary";
import type { DozoAvatarGeneratePanel as LoadedDozoAvatarGeneratePanel } from "../pages/shell/dozo-avatar-generate-panel";
import type { DozoBotSkillsSection as LoadedDozoBotSkillsSection } from "../pages/shell/dozo-bot-skills-section";
import type { OwnComputerRow as LoadedOwnComputerRow } from "../pages/shell/dozo-own-computer-row";
import type { SiteSessionsControl as LoadedSiteSessionsControl } from "../pages/shell/dozo-site-sessions";
import { lazyComponent } from "./preload-recovery";

// The fork's screens that are not needed to draw the first page: each loads when it is first shown,
// so the code the app starts with stays under its budget (scripts/checks/bundle-size.budgets.json).
// Anchored rules in dozo/brand/brand.json import these names where upstream's screens place them.
// Each one sits inside something the person opens (the bot panel, the computer window, the model
// settings, the avatar studio); a screen
// in the thread itself, or one the first page reads helpers from, stays a plain import. Nothing
// shows while the code is on its way; `preloadDozoSurfaces` fetches them once the app is idle, so
// opening the panel right after the page has drawn is the only time anything moves. A chunk that
// cannot load leaves the panel's own "Could not load" line in its place, never the app.

const loadAvatarPanel = () => import("../pages/shell/dozo-avatar-generate-panel");
const loadCliAccounts = () => import("../pages/model-settings/dozo-cli-accounts");
const loadSiteSessions = () => import("../pages/shell/dozo-site-sessions");
const loadSkillsSection = () => import("../pages/shell/dozo-bot-skills-section");
const loadOwnComputerRow = () => import("../pages/shell/dozo-own-computer-row");

const LazyDozoAvatarGeneratePanel = lazyComponent(() =>
  loadAvatarPanel().then((module) => module.DozoAvatarGeneratePanel),
);
const LazyDozoCliAccounts = lazyComponent(() =>
  loadCliAccounts().then((module) => module.DozoCliAccounts),
);
const LazySiteSessionsControl = lazyComponent(() =>
  loadSiteSessions().then((module) => module.SiteSessionsControl),
);
const LazyDozoBotSkillsSection = lazyComponent(() =>
  loadSkillsSection().then((module) => module.DozoBotSkillsSection),
);
const LazyOwnComputerRow = lazyComponent(() =>
  loadOwnComputerRow().then((module) => module.OwnComputerRow),
);

/** Fetches the code of every screen here; a failure shows when the screen is opened. */
export function preloadDozoSurfaces() {
  return Promise.all([
    loadAvatarPanel(),
    loadCliAccounts(),
    loadSiteSessions(),
    loadSkillsSection(),
    loadOwnComputerRow(),
  ]);
}

function Held({ children, failed }: { children: ReactNode; failed?: ReactNode }) {
  return (
    <ErrorBoundary fallback={failed === undefined ? <SectionLoadFailed /> : failed}>
      <Suspense fallback={null}>{children}</Suspense>
    </ErrorBoundary>
  );
}

/** The avatar studio's Generate tab; its trigger stays in the studio, the form loads with it. */
export function DozoAvatarGeneratePanel(
  props: ComponentProps<typeof LoadedDozoAvatarGeneratePanel>,
) {
  return (
    <Held>
      <LazyDozoAvatarGeneratePanel {...props} />
    </Held>
  );
}

/** Drawn only where the server lists tools of its own computer; nothing otherwise, and on failure. */
export function DozoCliAccounts() {
  return (
    <Held failed={null}>
      <LazyDozoCliAccounts />
    </Held>
  );
}

export function SiteSessionsControl(props: ComponentProps<typeof LoadedSiteSessionsControl>) {
  return (
    <Held>
      <LazySiteSessionsControl {...props} />
    </Held>
  );
}

export function DozoBotSkillsSection(props: ComponentProps<typeof LoadedDozoBotSkillsSection>) {
  return (
    <Held>
      <LazyDozoBotSkillsSection {...props} />
    </Held>
  );
}

export function OwnComputerRow(props: ComponentProps<typeof LoadedOwnComputerRow>) {
  return (
    <Held>
      <LazyOwnComputerRow {...props} />
    </Held>
  );
}
