import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Whether this server ships the third-party notices (`dozo/server-bundle/notices.mjs`). Only the
 * local server bundle does: its processes run from the bundle's folder, which holds the file. The
 * public auth capabilities pass it on as `notices`, so the web app links the notices page only
 * where it exists and never asks a hosted server for it.
 */
export const NOTICES_FILE = "THIRD-PARTY-NOTICES.txt";

export function shipsNotices(cwd = process.cwd()): boolean {
  return existsSync(path.join(cwd, NOTICES_FILE));
}
