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
import { shouldSkipPortableWorkspaceFile } from "./workspace-save-policy.js";

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
 * Copy and check, then `flip` (the bot's computer changes), then delete what it left. A copy or
 * flip that fails removes the copy and leaves the bot where it was. After the flip the Team
 * Computer is cleared at once or by the sweep (`recoverBotComputerSwitch`); an Own computer that
 * keeps a copy keeps it private. The caller holds `switchLeaseKey` and the bot does not run.
 */
export async function moveBotComputerFiles<T>(
  deps: ComputerMoveDeps,
  input: { botId: string; from: MovingComputer; to: MovingComputer; flip: () => Promise<T> },
  context: AdapterContext,
): Promise<T> {
  const { botId, from, to, flip } = input;
  if (from.id === to.id) return flip();
  if (!movesBotFiles(from.kind) || !movesBotFiles(to.kind)) {
    // A computer that never started holds nothing to move.
    if (!from.providerRef) return flip();
    throw new BotFilesNotMovedError(BOT_FILES_UNMOVABLE);
  }
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
      const large = await largeFiles(source.root, botId, from.scope, profile);
      if (large.length)
        throw new BotFilesNotMovedError(`${BOT_FILES_TOO_LARGE}: ${large.join(", ")}`);
      for await (const file of botFiles(deps.home, input, profile, ctx)) {
        if (file.content.byteLength > MAX_MOVED_FILE_BYTES) {
          throw new BotFilesNotMovedError(`${BOT_FILES_TOO_LARGE}: ${file.path}`);
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
      await source.removeEntries(moved);
    } catch (error) {
      getLogger().error("bot file move cleanup", error);
      // On an Own computer the copy left behind stays private; a Team Computer is cleared later.
      if (from.scope === "team") await markSwitchDue(deps.prisma, botId);
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

async function markSwitchDue(prisma: PrismaClient, botId: string) {
  await prisma.$executeRaw`
    INSERT INTO "leases" ("key", "fence", "expiresAt")
    VALUES (${switchDueKey(botId)}, nextval('leases_fence_seq'), clock_timestamp())
    ON CONFLICT ("key") DO NOTHING`;
}

/**
 * Finish a switch that stopped part way (its process died, or the Team Computer could not be
 * cleared): free the computers it held, and when the bot is on its Own computer, remove its
 * folder and profile from the Team Computer. Its own computer keeps any copy, which is private.
 * Clears the bot's switching flag once the switch is clearly not running. Returns whether
 * nothing is left to do. The caller holds `switchLeaseKey`.
 */
export async function recoverBotComputerSwitch(
  deps: ComputerMoveDeps,
  botId: string,
  context: AdapterContext,
  staleMs: number,
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
  if (bot.computer?.scope === "dedicated" && profile && isTeamBotFolderName(botId)) {
    const team = await deps.prisma.computer.findUnique({
      where: {
        scopeKey: computerScopeKey({
          mode: "team",
          spaceId: bot.spaceId,
          userId: await teamComputerUserId(deps.prisma, bot),
        }),
      },
      select: { id: true, homeKey: true, kind: true, providerRef: true, scope: true },
    });
    if (team && movesBotFiles(team.kind)) {
      const ctx: AdapterContext = { ...context, botId, screenLeaseId: undefined };
      const held: MovingComputer[] = [];
      try {
        const home = await openHome(deps, team, botId, ctx, held);
        await home.removeEntries([
          ["bots", botId],
          [".browser-profiles", profile],
        ]);
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
 * inside the folder are followed, links out of it and anything but files and folders are passed.
 */
async function largeFiles(root: string, botId: string, scope: string, profile: string) {
  const large: string[] = [];
  const walk = async (
    top: string,
    directory: string,
    relative: string,
    policy: string,
    skipHidden: boolean,
  ) => {
    for (const entry of await readdir(directory)) {
      const shown = path.posix.join(relative, entry);
      if (skipHidden && !relative && entry.startsWith(".")) continue;
      const full = await realpath(path.join(directory, entry)).catch(() => null);
      if (!full?.startsWith(`${top}${path.sep}`)) continue;
      const info = await stat(full);
      if (shouldSkipPortableWorkspaceFile(path.posix.join(policy, shown), info.isDirectory())) {
        continue;
      }
      if (info.isDirectory()) await walk(top, full, shown, policy, false);
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
      await walk(top, top, "", policy, skipHidden);
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
