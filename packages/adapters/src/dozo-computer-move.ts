import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { ClientError, retry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { computerScopeKey, teamComputerUserId } from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { toComputerRef } from "./computer-support.js";
import {
  isTeamBotFolderName,
  removeComputerWorkspaceDirectories,
  teamBrowserProfileName,
} from "./computer-workspace.js";
import { removeAgentHomeFolders, resolveAgentHomePath } from "./home.js";
import { sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";
import { shouldSkipPortableWorkspaceFile, WORKSPACE_SAVE_LIMITS } from "./workspace-save-policy.js";

export const BOT_FILES_NOT_MOVED = "Couldn't move this bot's files. Try again.";
export const BOT_FILES_UNMOVABLE = "This computer can't move a bot's files.";
/** Followed by ": " and the files' names. */
export const BOT_FILES_TOO_LARGE = "Files over 12 MB can't move";
/**
 * The largest file a move carries: what a running computer accepts in one write (16 MB of
 * base64), held to on every computer so a switch never depends on whether one is running.
 */
export const MAX_MOVED_FILE_BYTES = 12 * 1024 * 1024;

/** The switch is undone: the bot stays on its computer with its files. */
export class BotFilesNotMovedError extends ClientError {
  constructor(message = BOT_FILES_NOT_MOVED, options?: ErrorOptions) {
    super("CONFLICT", message, "BOT_FILES_NOT_MOVED", options);
  }
}

export interface MovingComputer {
  id: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  scope: string;
}

export interface ComputerMoveDeps {
  prisma: PrismaClient;
  sandbox: SandboxProvider;
  home: AgentHomeStore;
  dataDir?: string;
}

/** The lease a switch holds; one left lapsed in the table is a switch to finish. */
export const switchLeaseKey = (botId: string) => `dozo-computer-switch:${botId}`;
/** A lapsed row the sweep finishes: the Team Computer still holds a bot that left it. */
export const switchDueKey = (botId: string) => `dozo-computer-switch-due:${botId}`;
/** What a stopped computer's `maintenanceId` says while a switch edits its home. */
const holdId = (botId: string) => `dozo-move:${botId}`;

const REMOVE_BATCH = 200;
/** The most entries and folder depth the size check walks; a bigger tree refuses the switch. */
const MAX_SCANNED_ENTRIES = WORKSPACE_SAVE_LIMITS.maxFiles;
const MAX_SCANNED_DEPTH = 64;
/** How many names a refusal for large files shows; the rest are counted. */
const LARGE_NAMES_SHOWN = 3;
const PROFILE_BUSY_ATTEMPTS = 3;
const PROFILE_BUSY_RETRY_MS = 1_000;

type Entry = readonly [parent: "" | "bots" | ".browser-profiles", name: string];

export function movesBotFiles(kind: string) {
  return sandboxKindCapabilities(kind).movesBotFiles === true;
}

/**
 * Switch a bot to another computer and move its files and browser profile there: on a Team
 * Computer they are `bots/<id>` and `.browser-profiles/<profile>`, on its Own computer the home's
 * visible entries and the same profile. `shared/` and the Own computer's hidden entries stay.
 *
 * Copy and check, then `flip` (the bot's computer changes, fenced by the caller's lease, and the
 * caller records that the computer it left is due a cleanup), then, while `stillHeld` confirms
 * the lease, delete what it left and call `cleared`. A copy or flip that fails removes the copy
 * and leaves the bot where it was. A cleanup that fails or never ran is the sweep's
 * (`recoverBotComputerSwitch`). The caller holds `switchLeaseKey` and the bot does not run.
 */
export async function moveBotComputerFiles<T>(
  deps: ComputerMoveDeps,
  input: {
    botId: string;
    from: MovingComputer;
    to: MovingComputer;
    flip: () => Promise<T>;
    stillHeld?: () => Promise<void>;
    cleared?: () => Promise<void>;
  },
  context: AdapterContext,
): Promise<T> {
  const { botId, from, to, flip } = input;
  // Nothing to move: the same computer, or one that never started and so holds nothing.
  const unmovable = !movesBotFiles(from.kind) || !movesBotFiles(to.kind);
  if (from.id === to.id || (unmovable && !from.providerRef)) {
    const flipped = await flip();
    await input.cleared?.();
    return flipped;
  }
  if (unmovable) throw new BotFilesNotMovedError(BOT_FILES_UNMOVABLE);
  const profile = teamBrowserProfileName(botId);
  if (!isTeamBotFolderName(botId) || !profile) throw new BotFilesNotMovedError();
  const ctx: AdapterContext = { ...context, botId, screenLeaseId: undefined };
  const held: MovingComputer[] = [];
  try {
    const source = await openHome(deps, from, botId, ctx, held);
    const dest = await openHome(deps, to, botId, ctx, held);
    const written: Array<{ path: string; size: number }> = [];
    let flipped: T;
    try {
      await source.releaseScreen();
      const large = await largeFiles(source.root, botId, from.scope, profile, ctx.signal);
      if (large.length) throw new BotFilesNotMovedError(tooLarge(large));
      for await (const file of botFiles(deps.home, input, profile, ctx)) {
        if (file.content.byteLength > MAX_MOVED_FILE_BYTES) {
          throw new BotFilesNotMovedError(tooLarge([file.path]));
        }
        ctx.signal.throwIfAborted();
        await dest.write(file);
        written.push({ path: file.path, size: file.content.byteLength });
      }
      await dest.verify(written);
      // A switch that lost its lease must not change the bot's computer behind the next one.
      ctx.signal.throwIfAborted();
      flipped = await flip();
    } catch (error) {
      // The bot stays where it was, so no part of the copy may stay: on a Team Computer the
      // other bots could read it, on its Own computer it would hide files the bot no longer has.
      await bestEffort(
        "bot file move rollback",
        dest.removeFiles(written.map((file) => file.path)),
      );
      throw notMoved(error);
    }
    const moved: Entry[] =
      from.scope === "team"
        ? [["bots", botId]]
        : (await ownRootEntries(deps.home, from.homeKey, ctx)).map((name) => ["", name] as const);
    moved.push([".browser-profiles", profile]);
    try {
      // A switch whose lease lapsed leaves the cleanup to whoever holds it now.
      await input.stillHeld?.();
      await source.removeEntries(moved);
      await input.cleared?.();
    } catch (error) {
      getLogger().error("bot file move cleanup", error);
    }
    return flipped;
  } catch (error) {
    throw notMoved(error);
  } finally {
    await releaseHolds(deps.prisma, botId, held);
  }
}

function notMoved(error: unknown) {
  if (error instanceof ClientError) return error;
  getLogger().error("bot file move", error);
  return new BotFilesNotMovedError(BOT_FILES_NOT_MOVED, { cause: error });
}

/** The first few names, then how many more: the refusal stays one short line. */
function tooLarge(names: readonly string[]) {
  const shown = names.slice(0, LARGE_NAMES_SHOWN).join(", ");
  const more = names.length - LARGE_NAMES_SHOWN;
  return `${BOT_FILES_TOO_LARGE}: ${shown}${more > 0 ? ` (+${more})` : ""}`;
}

/**
 * Finish a switch that stopped part way (its process died, or the computer it left could not be
 * cleared): free the computers it held, and when the bot is on its Own computer, remove its
 * folder and profile from the Team Computer. On the Team Computer, its Own computer is cleared
 * only when `cleanupDue` (the switch changed the bot's computer, so everything there was copied
 * first); a copy from a switch that never got that far stays private there. Clears the bot's
 * switching flag once the switch is clearly not running. Returns whether nothing is left to do.
 * The caller holds `switchLeaseKey`.
 */
export async function recoverBotComputerSwitch(
  deps: ComputerMoveDeps,
  botId: string,
  context: AdapterContext,
  staleMs: number,
  cleanupDue = false,
): Promise<boolean> {
  await deps.prisma.computer.updateMany({
    where: { maintenanceId: holdId(botId) },
    data: { maintenanceId: null },
  });
  const bot = await deps.prisma.bot.findUnique({
    where: { id: botId },
    select: {
      spaceId: true,
      userId: true,
      computerSwitching: true,
      updatedAt: true,
      computer: { select: { scope: true } },
    },
  });
  if (!bot) return true;
  const profile = teamBrowserProfileName(botId);
  const onOwn = bot.computer?.scope === "dedicated";
  if (profile && isTeamBotFolderName(botId) && (onOwn || cleanupDue)) {
    // The computer the bot left: the Space's Team Computer, or its own.
    const left = await deps.prisma.computer.findUnique({
      where: {
        scopeKey: onOwn
          ? computerScopeKey({
              mode: "team",
              spaceId: bot.spaceId,
              userId: await teamComputerUserId(deps.prisma, bot),
            })
          : computerScopeKey({
              mode: "dedicated",
              spaceId: bot.spaceId,
              userId: bot.userId,
              botId,
            }),
      },
      select: { id: true, homeKey: true, kind: true, providerRef: true, scope: true },
    });
    if (left && movesBotFiles(left.kind)) {
      const ctx: AdapterContext = { ...context, botId, screenLeaseId: undefined };
      const held: MovingComputer[] = [];
      try {
        const home = await openHome(deps, left, botId, ctx, held);
        const entries: Entry[] = onOwn
          ? [["bots", botId]]
          : (await ownRootEntries(deps.home, left.homeKey, ctx)).map((name) => ["", name] as const);
        entries.push([".browser-profiles", profile]);
        await home.removeEntries(entries);
      } catch (error) {
        getLogger().warn("bot file move recovery", { error });
        return false;
      } finally {
        await releaseHolds(deps.prisma, botId, held);
      }
    }
  }
  if (!bot.computerSwitching) return true;
  // A switch sets the flag a moment before it takes its lease: only an old flag is a dead one.
  if (Date.now() - bot.updatedAt.getTime() < staleMs) return false;
  await deps.prisma.bot.updateMany({
    where: { id: botId, computerSwitching: true, updatedAt: bot.updatedAt },
    data: { computerSwitching: false },
  });
  return true;
}

/** The bot's files on the computer it leaves, with their paths on the one it joins. */
async function* botFiles(
  home: AgentHomeStore,
  { botId, from, to }: { botId: string; from: MovingComputer; to: MovingComputer },
  profile: string,
  context: AdapterContext,
): AsyncGenerator<PortableFile> {
  const filesDirectory = (computer: MovingComputer) =>
    computer.scope === "team" ? `bots/${botId}` : "";
  for await (const file of home.exportHome(from.homeKey, context, {
    directory: filesDirectory(from),
    skipHidden: from.scope !== "team",
  })) {
    yield { ...file, path: path.posix.join(filesDirectory(to), file.path) };
  }
  const profileDirectory = `.browser-profiles/${profile}`;
  for await (const file of home.exportHome(from.homeKey, context, {
    directory: profileDirectory,
  })) {
    const relative = `${profileDirectory}/${file.path}`;
    if (shouldSkipPortableWorkspaceFile(relative)) continue;
    yield { ...file, path: relative };
  }
}

async function ownRootEntries(home: AgentHomeStore, homeKey: string, context: AdapterContext) {
  return (await home.list(homeKey, "", context))
    .map((entry) => path.posix.basename(entry.path))
    .filter((name) => !name.startsWith("."));
}

/**
 * The files the move would carry that are over the limit, by their path in the bot's folder or
 * profile, read from the sizes alone before anything is copied. Walks as the export does: links
 * inside the folder are followed, each folder once, and links out of it and anything but files
 * and folders are passed. Other bots can write the folder, so the walk is bounded: a tree past
 * the entry or depth limit refuses the switch, and a switch that stops waiting stops it.
 */
async function largeFiles(
  root: string,
  botId: string,
  scope: string,
  profile: string,
  signal: AbortSignal,
) {
  const large: string[] = [];
  const visited = new Set<string>();
  let entries = 0;
  const walk = async (
    top: string,
    directory: string,
    relative: string,
    policy: string,
    skipHidden: boolean,
    depth: number,
  ) => {
    if (visited.has(directory)) return;
    visited.add(directory);
    if (depth > MAX_SCANNED_DEPTH) throw new BotFilesNotMovedError();
    for (const entry of await readdir(directory)) {
      signal.throwIfAborted();
      if (++entries > MAX_SCANNED_ENTRIES) throw new BotFilesNotMovedError();
      const shown = path.posix.join(relative, entry);
      if (skipHidden && !relative && entry.startsWith(".")) continue;
      const full = await realpath(path.join(directory, entry)).catch(() => null);
      if (!full?.startsWith(`${top}${path.sep}`)) continue;
      const info = await stat(full);
      if (shouldSkipPortableWorkspaceFile(path.posix.join(policy, shown), info.isDirectory())) {
        continue;
      }
      if (info.isDirectory()) await walk(top, full, shown, policy, false, depth + 1);
      else if (info.isFile() && info.size > MAX_MOVED_FILE_BYTES) large.push(shown);
    }
  };
  const base = await realpath(root).catch(() => null);
  if (!base) return large;
  for (const [directory, policy, skipHidden] of [
    [scope === "team" ? `bots/${botId}` : "", "", scope !== "team"],
    [`.browser-profiles/${profile}`, `.browser-profiles/${profile}`, false],
  ] as const) {
    // As the export: a folder that is itself a link is not followed.
    const expected = path.join(base, directory);
    const top = await realpath(expected).catch(() => null);
    if (top === expected && (await stat(top)).isDirectory()) {
      await walk(top, top, "", policy, skipHidden, 0);
    }
  }
  return large;
}

interface HomeAccess {
  root: string;
  releaseScreen(): Promise<void>;
  write(file: PortableFile): Promise<void>;
  verify(files: ReadonlyArray<{ path: string; size: number }>): Promise<void>;
  removeFiles(paths: readonly string[]): Promise<void>;
  removeEntries(entries: readonly Entry[]): Promise<void>;
}

/**
 * A computer's home for the move: a running one is changed through the computer itself, since
 * its bots could swap a folder for a link under the server; a stopped one is changed on the
 * server while its `maintenanceId` keeps it from starting (`provisionComputer` refuses a held
 * computer). A computer starting or stopping refuses.
 */
async function openHome(
  deps: ComputerMoveDeps,
  computer: MovingComputer,
  botId: string,
  context: AdapterContext,
  held: MovingComputer[],
): Promise<HomeAccess> {
  const root = resolveAgentHomePath(deps.home, computer.homeKey, deps.dataDir);
  const current = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: computer.id },
    select: { state: true, providerRef: true },
  });
  if (current.state === "running" && current.providerRef) {
    return runningHome(deps, { ...computer, providerRef: current.providerRef }, root, context);
  }
  const claimed = await deps.prisma.computer.updateMany({
    where: { id: computer.id, state: "stopped", maintenanceId: null },
    data: { maintenanceId: holdId(botId) },
  });
  if (claimed.count !== 1) throw new BotFilesNotMovedError();
  held.push(computer);
  return stoppedHome(deps, computer, root);
}

async function releaseHolds(prisma: PrismaClient, botId: string, held: MovingComputer[]) {
  for (const computer of held) {
    await bestEffort(
      "release a computer the move held",
      prisma.computer.updateMany({
        where: { id: computer.id, maintenanceId: holdId(botId) },
        data: { maintenanceId: null },
      }),
    );
  }
}

function runningHome(
  deps: ComputerMoveDeps,
  computer: MovingComputer,
  root: string,
  context: AdapterContext,
): HomeAccess {
  const ref = toComputerRef(computer);
  return {
    root,
    releaseScreen: async () => {
      // The bot's browser holds its profile open; it is not running, so nothing is lost.
      if (computer.scope === "team") await deps.sandbox.releaseScreen?.(ref, context);
    },
    write: (file) => deps.sandbox.writeFile(ref, file, context),
    verify: (files) => verifyFiles(root, files),
    removeFiles: async (paths) => {
      for (let start = 0; start < paths.length; start += REMOVE_BATCH) {
        await run(
          deps.sandbox,
          ref,
          ["rm", "-f", "--", ...paths.slice(start, start + REMOVE_BATCH)],
          context,
        );
      }
    },
    removeEntries: async (entries) => {
      for (const [parent, name] of entries) {
        // Only a Team Computer's folders are removed while it runs; an Own computer is stopped.
        if (parent === "") throw new BotFilesNotMovedError();
        await retry(
          () => removeComputerWorkspaceDirectories(deps.sandbox, ref, parent, [name], context),
          {
            attempts: PROFILE_BUSY_ATTEMPTS,
            delayMs: PROFILE_BUSY_RETRY_MS,
            // Chromium's helpers can hold the profile's databases open briefly after the stop.
            retryable: (error) =>
              error instanceof Error && error.message.includes("Device or resource busy"),
            signal: context.signal,
          },
        );
      }
    },
  };
}

/**
 * The server's side of a stopped home. Nothing else writes it meanwhile: the hold keeps the
 * computer from starting, and for a computer that works in the server's home the store only
 * records revisions there (`checkpointComputerWorkspace`), it never swaps the folder.
 */
function stoppedHome(deps: ComputerMoveDeps, computer: MovingComputer, root: string): HomeAccess {
  return {
    root,
    releaseScreen: async () => {},
    write: (file) => writeContained(root, file),
    verify: (files) => verifyFiles(root, files),
    removeFiles: async (paths) => {
      for (const relative of paths) await unlinkContained(root, relative);
    },
    removeEntries: async (entries) => {
      for (const [parent, name] of entries) {
        await removeAgentHomeFolders(deps.home, computer.homeKey, parent, [name], deps.dataDir);
      }
    },
  };
}

async function run(
  sandbox: SandboxProvider,
  ref: ReturnType<typeof toComputerRef>,
  argv: string[],
  context: AdapterContext,
) {
  let exitCode: number | undefined;
  let stderr = "";
  for await (const event of sandbox.execute(ref, { argv, cwd: "." }, context)) {
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") exitCode = event.code;
  }
  if (exitCode !== 0) throw new Error(`command failed: ${stderr.trim()}`);
}

/** Each copied file is on the computer whole: a regular file of the size that was read. */
async function verifyFiles(root: string, files: ReadonlyArray<{ path: string; size: number }>) {
  for (const file of files) {
    const info = await lstat(path.join(root, file.path)).catch(() => null);
    if (!info?.isFile() || info.size !== file.size) {
      throw new Error(`moved file did not arrive: ${file.path}`);
    }
  }
}

/** Where `relative` goes under `root`, its folders made where missing; a link or a file on the way refuses. */
async function containedPath(root: string, relative: string) {
  await mkdir(root, { recursive: true });
  let directory = root;
  for (const part of path.posix.dirname(relative).split("/")) {
    if (part === ".") continue;
    directory = path.join(directory, part);
    const info = await lstat(directory).catch(() => null);
    if (info?.isDirectory()) continue;
    if (info) throw new Error("path escapes the home");
    await mkdir(directory);
  }
  return path.join(directory, path.posix.basename(relative));
}

async function writeContained(root: string, file: PortableFile) {
  const handle = await open(
    await containedPath(root, file.path),
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    file.executable ? 0o755 : 0o644,
  );
  try {
    await handle.writeFile(file.content);
  } finally {
    await handle.close();
  }
}

/** A link in the file's place is removed, never followed. */
async function unlinkContained(root: string, relative: string) {
  await rm(await containedPath(root, relative), { force: true });
}
