import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ComponentType, LazyExoticComponent } from "react";
import { lazyComponent } from "../lib/preload-recovery";

export type DozoAdminSection = {
  /** Its address under `/admin`; "" is the members list. */
  path: string;
  label: MessageDescriptor;
  /**
   * The section's page, loaded when it opens, at `/admin/<path>`. Only the members list has none:
   * it is the admin page's own. Upstream's free access and plugin pages are their panels here,
   * without their own header, so the navigation stays.
   */
  page?: LazyExoticComponent<ComponentType>;
  /** Listed only on a server that bills (`billingEnabled`): without billing it has nothing to show. */
  billing?: true;
};

/**
 * The admin page's sections, in the order its navigation shows them. A section is listed once it
 * has a page: add one line here with its `page` (through `lazyComponent`).
 */
export const DOZO_ADMIN_NAV: readonly DozoAdminSection[] = [
  { path: "", label: msg`Members` },
  {
    path: "access",
    label: msg`Free access`,
    billing: true,
    page: lazyComponent(() =>
      import("./AdminAccessPage").then((module) => module.AccessGrantsPanel),
    ),
  },
  {
    path: "plugins",
    label: msg`Plugins`,
    page: lazyComponent(() =>
      import("./PluginSubmissionsPanel").then((module) => module.PluginSubmissionsPanel),
    ),
  },
  {
    path: "settings",
    label: msg`Site settings`,
    page: lazyComponent(() =>
      import("./dozo-admin-settings").then((module) => module.DozoAdminSettingsPage),
    ),
  },
  {
    path: "plans",
    label: msg`Plans`,
    page: lazyComponent(() => import("./dozo-admin-plans").then((module) => module.DozoAdminPlans)),
  },
  {
    path: "billing",
    label: msg`Billing`,
    page: lazyComponent(() =>
      import("./dozo-admin-billing").then((module) => module.DozoAdminBilling),
    ),
  },
  {
    path: "funnel",
    label: msg`Funnel`,
    page: lazyComponent(() =>
      import("./dozo-admin-funnel").then((module) => module.DozoAdminFunnel),
    ),
  },
];
