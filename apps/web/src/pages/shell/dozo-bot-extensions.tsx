import type { DozoLazyLoader } from "../../lib/dozo-lazy-list";
import { DozoLazyList, dozoLazyEntries } from "../../lib/dozo-lazy-list";
import type { createSpaceRpc } from "../../lib/query/rpc";

export type DozoBotMenuItemProps = {
  rpc: ReturnType<typeof createSpaceRpc>;
  botId: string;
  name: string;
  onClose: () => void;
};
export type DozoBotSettingsRowProps = { botId: string; spaceId: string };

/**
 * A bot's roster menu items after Export, each a `ContextMenuItem` that calls `onClose` first. A
 * feature adds one line: `() => import("./x").then((module) => module.X)`.
 */
const BOT_MENU_ITEMS: DozoLazyLoader<DozoBotMenuItemProps>[] = [
  () => import("./dozo-bot-share-menu-item").then((module) => module.DozoBotShareMenuItem),
];

/** Rows in a bot's settings panel, after its model backups. A feature adds one line, as above. */
const BOT_SETTINGS_ROWS: DozoLazyLoader<DozoBotSettingsRowProps>[] = [
  () => import("./dozo-night-notes-row").then((module) => module.DozoNightNotesRow),
];

const menuItems = dozoLazyEntries(BOT_MENU_ITEMS);
const settingsRows = dozoLazyEntries(BOT_SETTINGS_ROWS);

export function DozoBotMenuItems(props: DozoBotMenuItemProps) {
  return <DozoLazyList entries={menuItems} props={props} />;
}

export function DozoBotSettingsRows(props: DozoBotSettingsRowProps) {
  return <DozoLazyList entries={settingsRows} props={props} />;
}
