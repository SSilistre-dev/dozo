import type { ComponentType } from "react";
import type { BotProfileAction } from "./bots/bot-profile-menu";
import { DozoNightNotesRow } from "./dozo-night-notes-row";

/** Rows at the end of General settings (dozo-general-rows.tsx). A feature adds its component. */
const SETTINGS_ROWS: ComponentType[] = [];

/** Rows in a bot's settings after its model backups (dozo-bot-backups.tsx); one line each. */
const BOT_SETTINGS_ROWS: ComponentType<{ botId: string }>[] = [DozoNightNotesRow];

export function DozoSettingsRows({ rows = SETTINGS_ROWS }: { rows?: readonly ComponentType[] }) {
  // The list never changes while the app runs, so a row's place is its key.
  return rows.map((Row, index) => <Row key={index} />);
}

export function DozoBotSettingsRows({
  botId,
  rows = BOT_SETTINGS_ROWS,
}: {
  botId: string;
  rows?: readonly ComponentType<{ botId: string }>[];
}) {
  return rows.map((Row, index) => <Row key={index} botId={botId} />);
}

/**
 * A bot's profile menu actions after the fork's own (dozo-bot-profile-menu.tsx). A feature adds one
 * line calling its hook, `...useX(botId, name),`, which returns the actions it shows now (and the
 * first one drops the underscores).
 */
export function useDozoBotActions(_botId: string, _name: string): BotProfileAction[] {
  return [];
}
