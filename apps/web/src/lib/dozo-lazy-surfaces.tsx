import type { ComponentProps } from "react";
import { Suspense } from "react";
import type { SkillDraftCard as LoadedSkillDraftCard } from "../components/teach/dozo-skill-draft-card";
import type { DozoBotSkillsSection as LoadedDozoBotSkillsSection } from "../pages/shell/dozo-bot-skills-section";
import type { OwnComputerRow as LoadedOwnComputerRow } from "../pages/shell/dozo-own-computer-row";
import type { SiteSessionsControl as LoadedSiteSessionsControl } from "../pages/shell/dozo-site-sessions";
import { lazyComponent } from "./preload-recovery";

// The fork's screens that are not needed to draw the first page: each loads when it is first shown,
// so the code the app starts with stays under its budget (scripts/checks/bundle-size.budgets.json).
// Anchored rules in dozo/brand/brand.json import these names where upstream's screens place them;
// every one is drawn inside something the person opens, so nothing shows while its code is on its
// way. A screen that has to be there at the first paint, or whose helpers the first page reads,
// stays a plain import.

const LazySkillDraftCard = lazyComponent(() =>
  import("../components/teach/dozo-skill-draft-card").then((module) => module.SkillDraftCard),
);
const LazySiteSessionsControl = lazyComponent(() =>
  import("../pages/shell/dozo-site-sessions").then((module) => module.SiteSessionsControl),
);
const LazyDozoBotSkillsSection = lazyComponent(() =>
  import("../pages/shell/dozo-bot-skills-section").then((module) => module.DozoBotSkillsSection),
);
const LazyOwnComputerRow = lazyComponent(() =>
  import("../pages/shell/dozo-own-computer-row").then((module) => module.OwnComputerRow),
);

export function SkillDraftCard(props: ComponentProps<typeof LoadedSkillDraftCard>) {
  return (
    <Suspense fallback={null}>
      <LazySkillDraftCard {...props} />
    </Suspense>
  );
}

export function SiteSessionsControl(props: ComponentProps<typeof LoadedSiteSessionsControl>) {
  return (
    <Suspense fallback={null}>
      <LazySiteSessionsControl {...props} />
    </Suspense>
  );
}

export function DozoBotSkillsSection(props: ComponentProps<typeof LoadedDozoBotSkillsSection>) {
  return (
    <Suspense fallback={null}>
      <LazyDozoBotSkillsSection {...props} />
    </Suspense>
  );
}

export function OwnComputerRow(props: ComponentProps<typeof LoadedOwnComputerRow>) {
  return (
    <Suspense fallback={null}>
      <LazyOwnComputerRow {...props} />
    </Suspense>
  );
}
