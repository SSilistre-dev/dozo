import { randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

/**
 * The home folders of the accounts the server added for a tool: one per account, under the
 * server's own data folder, readable by nobody else. The person's own home folder of the tool is
 * never here and never touched.
 */
export function cliAccountsRoot(env: NodeJS.ProcessEnv = process.env): string {
  return resolve(env.DATA_DIR?.trim() || "./data", "cli-accounts");
}

const ACCOUNT_ID = /^[0-9a-f]{32}$/;

/** A new, empty home for an account of `provider`. */
export async function createAccountHome(provider: string): Promise<{ id: string; path: string }> {
  const folder = join(cliAccountsRoot(), provider);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const id = randomBytes(16).toString("hex");
  const path = join(folder, id);
  await mkdir(path, { mode: 0o700 });
  return { id, path };
}

/**
 * The account's home, only when it is the folder the server made: a real directory at exactly
 * that place (no link anywhere on the way), owned by the server's user and closed to others.
 * Anything else is not used, so the tool never starts on a folder someone else put there.
 */
export async function accountHome(provider: string, id: string): Promise<string | undefined> {
  if (!ACCOUNT_ID.test(id)) return undefined;
  const root = cliAccountsRoot();
  const path = join(root, provider, id);
  try {
    const [info, real, realRoot] = await Promise.all([lstat(path), realpath(path), realpath(root)]);
    const owned = info.uid === process.getuid?.() && (info.mode & 0o777) === 0o700;
    return info.isDirectory() && owned && real === join(realRoot, provider, id) ? path : undefined;
  } catch {
    // Gone, or not readable: either way not a home the server made.
    return undefined;
  }
}

/** The ids of the homes the server holds for `provider`. */
export async function accountHomeIds(provider: string): Promise<string[]> {
  try {
    const names = await readdir(join(cliAccountsRoot(), provider));
    return names.filter((name) => ACCOUNT_ID.test(name));
  } catch (error) {
    // No account was ever added.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

/** Removes an account's home with everything the tool kept in it. */
export async function removeAccountHome(provider: string, id: string): Promise<void> {
  if (!ACCOUNT_ID.test(id)) return;
  const root = cliAccountsRoot();
  const folder = join(root, provider);
  // Only inside the provider's own folder: a link put in its place leads nowhere to remove.
  let inside: boolean;
  try {
    inside = (await realpath(folder)) === join(await realpath(root), provider);
  } catch (error) {
    // Nothing was ever added for this provider.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (!inside) return;
  await rm(join(folder, id), { recursive: true, force: true });
}
