import type { ComponentProps, ReactNode } from "react";
import { Suspense } from "react";
import { ErrorBoundary, SectionLoadFailed } from "../components/ErrorBoundary";
import type { SkillDraftCard as LoadedSkillDraftCard } from "../components/teach/dozo-skill-draft-card";
import type { TeachCaptureOverlay as LoadedTeachCaptureOverlay } from "../components/teach/dozo-teach-capture-overlay";
import type { DozoOrganizationLibrarySwitch as LoadedDozoOrganizationLibrarySwitch } from "../pages/dozo-organization-library-switch";
import type { DozoAvatarGeneratePanel as LoadedDozoAvatarGeneratePanel } from "../pages/shell/dozo-avatar-generate-panel";
import type { DozoBotBackups as LoadedDozoBotBackups } from "../pages/shell/dozo-bot-backups";
import { DozoBotSettingsRows } from "../pages/shell/dozo-bot-extensions";
import type { DozoBotSkillsSection as LoadedDozoBotSkillsSection } from "../pages/shell/dozo-bot-skills-section";
import type {
  DozoPinMenuItem as LoadedDozoPinMenuItem,
  DozoPinnedMessages as LoadedDozoPinnedMessages,
} from "../pages/shell/dozo-message-pins";
import type { OwnComputerRow as LoadedOwnComputerRow } from "../pages/shell/dozo-own-computer-row";
import type { SiteSessionsControl as LoadedSiteSessionsControl } from "../pages/shell/dozo-site-sessions";
import { lazyComponent } from "./platform/preload-recovery";

// The fork's screens that are not needed to draw the first page: each loads when it is first shown,
// so the code the app starts with stays under its budget (scripts/checks/bundle-size.budgets.json).
// Anchored rules in dozo/brand/brand.json import these names where upstream's screens place them.
// Each one sits inside something the person opens (the bot panel, the computer window, the model
// settings, the avatar studio), or shows only when the server or a recording asks for it (a draft
// card, the capture overlay, the lines under the page, the pins). What the first page draws, and
// the small helpers it reads from these screens (`dozo-stream-changed.ts`), stay plain imports.
// Nothing shows while the code is on its way; `preloadDozoSurfaces` fetches them once the app is idle, so
// opening the panel right after the page has drawn is the only time anything moves. A chunk that
// cannot load leaves the panel's own "Could not load" line in its place, never the app.

const loadAvatarPanel = () => import("../pages/shell/dozo-avatar-generate-panel");
const loadCliAccounts = () => import("../pages/model-settings/dozo-cli-accounts");
const loadSiteSessions = () => import("../pages/shell/dozo-site-sessions");
const loadSkillsSection = () => import("../pages/shell/dozo-bot-skills-section");
const loadOwnComputerRow = () => import("../pages/shell/dozo-own-computer-row");
const loadOrganizationLibrary = () => import("../pages/dozo-organization-library-switch");
const loadBotBackups = () => import("../pages/shell/dozo-bot-backups");
const loadSkillDraftCard = () => import("../components/teach/dozo-skill-draft-card");
const loadTeachCaptureOverlay = () => import("../components/teach/dozo-teach-capture-overlay");
const loadAnnouncementLines = () => import("../components/dozo-announcement-lines");
const loadMessagePins = () => import("../pages/shell/dozo-message-pins");
const loadMessageExtensions = () => import("../pages/shell/dozo-message-extensions");

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
const LazyDozoBotBackups = lazyComponent(() =>
  loadBotBackups().then((module) => module.DozoBotBackups),
);

const LazySkillDraftCard = lazyComponent(() =>
  loadSkillDraftCard().then((module) => module.SkillDraftCard),
);
const LazyTeachCaptureOverlay = lazyComponent(() =>
  loadTeachCaptureOverlay().then((module) => module.TeachCaptureOverlay),
);
const LazyAnnouncementLines = lazyComponent(() =>
  loadAnnouncementLines().then((module) => module.DozoAnnouncementLines),
);
const LazyPinMenuItem = lazyComponent(() =>
  loadMessagePins().then((module) => module.DozoPinMenuItem),
);
const LazyMessageMenuItems = lazyComponent(() =>
  loadMessageExtensions().then((module) => module.DozoMessageMenuItems),
);
const LazyPinnedMessages = lazyComponent(() =>
  loadMessagePins().then((module) => module.DozoPinnedMessages),
);

const LazyOrganizationLibrarySwitch = lazyComponent(() =>
  loadOrganizationLibrary().then((module) => module.DozoOrganizationLibrarySwitch),
);
const LazyLibraryBadge = lazyComponent(() =>
  loadOrganizationLibrary().then((module) => module.DozoLibraryBadge),
);
const LazyHiddenLibrarySkills = lazyComponent(() =>
  loadOrganizationLibrary().then((module) => module.DozoHiddenLibrarySkills),
);

/** Fetches the code of every screen here; a failure shows when the screen is opened. */
export function preloadDozoSurfaces() {
  return Promise.all([
    loadAvatarPanel(),
    loadCliAccounts(),
    loadSiteSessions(),
    loadSkillsSection(),
    loadOwnComputerRow(),
    loadOrganizationLibrary(),
    loadBotBackups(),
    loadSkillDraftCard(),
    loadTeachCaptureOverlay(),
    loadAnnouncementLines(),
    loadMessagePins(),
    loadMessageExtensions(),
  ]);
}

function Held({
  children,
  failed,
  placeholder = null,
}: {
  children: ReactNode;
  failed?: ReactNode;
  /** What stands where the screen will be, so the rows below it do not move when it arrives. */
  placeholder?: ReactNode;
}) {
  return (
    <ErrorBoundary fallback={failed === undefined ? <SectionLoadFailed /> : failed}>
      <Suspense fallback={placeholder}>{children}</Suspense>
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

/** The room the skills section keeps beside the 24px gap above it, measured in the running app. */
const SKILLS_SECTION_ROOM = <div aria-hidden="true" data-dozo-skills-room className="h-6" />;

export function DozoBotSkillsSection(props: ComponentProps<typeof LoadedDozoBotSkillsSection>) {
  return (
    <Held placeholder={SKILLS_SECTION_ROOM}>
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

/** The Organization switch in a skill's editor, which the person has opened. */
export function DozoOrganizationLibrarySwitch(
  props: ComponentProps<typeof LoadedDozoOrganizationLibrarySwitch>,
) {
  return (
    <Held>
      <LazyOrganizationLibrarySwitch {...props} />
    </Held>
  );
}

/** The label on a skill that comes from the organization's library; nothing if its code fails. */
export function DozoLibraryBadge() {
  return (
    <Held failed={null}>
      <LazyLibraryBadge />
    </Held>
  );
}

/** The library skills this member turned off, under their skills; nothing if its code fails. */
export function DozoHiddenLibrarySkills() {
  return (
    <Held failed={null}>
      <LazyHiddenLibrarySkills />
    </Held>
  );
}

/**
 * Nothing while it loads, and nothing if it cannot: the bot keeps the runner's backups. The fork's
 * other bot settings rows follow (dozo-bot-extensions.tsx).
 */
export function DozoBotBackups(props: ComponentProps<typeof LoadedDozoBotBackups>) {
  return (
    <>
      <Held failed={null}>
        <LazyDozoBotBackups {...props} />
      </Held>
      <DozoBotSettingsRows botId={props.botId} spaceId={props.spaceId} />
    </>
  );
}

/** A taught skill's draft in the thread; the thread draws without it until a draft appears. */
export function SkillDraftCard(props: ComponentProps<typeof LoadedSkillDraftCard>) {
  return (
    <Held>
      <LazySkillDraftCard {...props} />
    </Held>
  );
}

/** Mounted only while a skill is being recorded, which is the only time it has anything to do. */
export function TeachCaptureOverlay(props: ComponentProps<typeof LoadedTeachCaptureOverlay>) {
  if (!props.enabled) return null;
  return (
    <Held>
      <LazyTeachCaptureOverlay {...props} />
    </Held>
  );
}

/** The failed-payment, verify-address and announcement lines; none shows while they load or fail. */
export function DozoAnnouncementLines() {
  return (
    <Held failed={null}>
      <LazyAnnouncementLines />
    </Held>
  );
}

/**
 * Pin or Unpin in a message's More menu, then the fork's other message items
 * (dozo-message-extensions.tsx); each joins the menu once its code is there.
 */
export function DozoPinMenuItem(props: ComponentProps<typeof LoadedDozoPinMenuItem>) {
  return (
    <>
      <Held failed={null}>
        <LazyPinMenuItem {...props} />
      </Held>
      <Held failed={null}>
        <LazyMessageMenuItems {...props} />
      </Held>
    </>
  );
}

/** The chat header's pin, drawn only while the chat has pinned messages. */
export function DozoPinnedMessages(props: ComponentProps<typeof LoadedDozoPinnedMessages>) {
  return (
    <Held failed={null}>
      <LazyPinnedMessages {...props} />
    </Held>
  );
}
