import type { ThreadMessage } from "@rakazo/contracts";
import type { DozoLazyLoader } from "../../lib/dozo-lazy-list";
import { DozoLazyList, dozoLazyEntries } from "../../lib/dozo-lazy-list";

export type DozoMessageMenuItemProps = { message: ThreadMessage; menuOpen: boolean };

/**
 * A message's More menu items after Pin, each a `DropdownMenuItem`. A feature adds one line:
 * `() => import("./x").then((module) => module.X)`.
 */
const MESSAGE_MENU_ITEMS: DozoLazyLoader<DozoMessageMenuItemProps>[] = [
  () => import("./dozo-replay-menu-item").then((module) => module.DozoReplayMenuItem),
];

const menuItems = dozoLazyEntries(MESSAGE_MENU_ITEMS);

export function DozoMessageMenuItems(props: DozoMessageMenuItemProps) {
  return <DozoLazyList entries={menuItems} props={props} />;
}
