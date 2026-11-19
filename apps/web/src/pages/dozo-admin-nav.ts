import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { ComponentType, LazyExoticComponent } from "react";
import { lazyComponent } from "../lib/preload-recovery";

export type DozoAdminSection = {
  /** Its address under `/admin`; "" is the members list. */
  path: string;
  label: MessageDescriptor;
  /**
   * The section's page, loaded when it opens, at `/admin/<path>`. Without one the address has a
   * route of its own: the members list is the admin page's own, the others are upstream pages.
   */
  page?: LazyExoticComponent<ComponentType>;
};

/**
 * The admin page's sections, in the order its navigation shows them. A section is listed once it
 * has a page: add one line here with its `page` (through `lazyComponent`).
 */
export const DOZO_ADMIN_NAV: readonly DozoAdminSection[] = [
  { path: "", label: msg`Members` },
  { path: "access", label: msg`Free access` },
  { path: "plugins", label: msg`Plugins` },
  {
    path: "settings",
    label: msg`Site settings`,
    page: lazyComponent(() =>
      import("./dozo-admin-settings").then((module) => module.DozoAdminSettingsPage),
    ),
  },
];
