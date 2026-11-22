import { queryClient } from "../../lib/query";

/** Where a bot's own backup models are cached: per user, Space and bot. */
export const DOZO_BOT_BACKUPS_KEY = "dozoBotModelBackups";

/** Reads every open bot's backups again; the roster signal carries a change to them. */
export function dozoBotBackupsChanged(client = queryClient): Promise<void> {
  return client.invalidateQueries({ queryKey: [DOZO_BOT_BACKUPS_KEY] });
}
