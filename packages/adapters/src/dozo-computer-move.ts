import { constants } from "node:fs";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";
import type {
  AdapterContext,
  AgentHomeStore,
  PortableFile,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { ClientError, retry } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
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

/** Folders on an Own computer that never belong to the bot: Team Computer layout names. */
const OWN_ROOT_SKIPPED = new Set(["bots", "shared"]);
/** A stopped computer is held against starting while its home is edited, at most this long. */
const STOPPED_HOLD_MS = 10 * 60_000;
const REMOVE_BATCH = 200;
const PROFILE_BUSY_ATTEMPTS = 3;
const PROFILE_BUSY_RETRY_MS = 1_000;

type Entry = readonly [parent: "" | "bots" | ".browser-profiles", name: string];

/**
 * Move a bot's files and browser profile from the computer it leaves to the one it joins: on a
 * Team Computer they are `bots/<id>` and `.browser-profiles/<profile>`, on its Own computer the
 * home's visible entries and the same profile. `shared/` and the Own computer's hidden entries
 * stay. Everything is copied and checked before anything is deleted; a failed copy leaves no part
 * of it on a Team Computer, and a failed delete leaves the copy, so trying again finishes.
 *
 * Only for computers that work in the server's home directory; the bot must not be running.
 */
export async function moveBotComputerFiles(
  deps: ComputerMoveDeps,
  input: { botId: string; from: MovingComputer; to: MovingComputer },
  context: AdapterContext,
): Promise<void> {
  const { botId, from, to } = input;
  if (from.id === to.id) return;
  const movable = (kind: string) => sandboxKindCapabilities(kind).serverHomeMount === "always";
  if (!movable(from.kind) || !movable(to.kind)) {
    // A computer that never started holds nothing to move.
    if (!from.providerRef) return;
    throw new BotFilesNotMovedError(BOT_FILES_UNMOVABLE);
  }
  const profile = teamBrowserProfileName(botId);
  if (!isTeamBotFolderName(botId) || !profile) throw new BotFilesNotMovedError();
  const ctx: AdapterContext = { ...context, botId, screenLeaseId: undefined };
  const written: Array<{ path: string; size: number }> = [];
  try {
    await onComputer(deps, from, ctx, (source) => source.releaseScreen());
    await onComputer(deps, to, ctx, async (dest) => {
      for await (const file of botFiles(deps.home, input, profile, ctx)) {
        await dest.write(file);
        written.push({ path: file.path, size: file.content.byteLength });
      }
      await dest.verify(written);
    });
  } catch (error) {
    // Nothing of this bot's may stay behind on a Team Computer it is not moving to.
    if (to.scope === "team" && written.length) {
      await bestEffort(
        "bot file move rollback",
        onComputer(deps, to, ctx, (dest) => dest.removeFiles(written.map((file) => file.path))),
      );
    }
    throw notMoved(error);
  }
  const moved: Entry[] =
    from.scope === "team"
      ? [["bots", botId]]
      : (await ownRootEntries(deps.home, from.homeKey, ctx)).map((name) => ["", name] as const);
  moved.push([".browser-profiles", profile]);
  try {
    await onComputer(deps, from, ctx, (source) => source.removeEntries(moved));
  } catch (error) {
    throw notMoved(error);
  }
}

function notMoved(error: unknown) {
  if (error instanceof BotFilesNotMovedError) return error;
  getLogger().error("bot file move", error);
  return new BotFilesNotMovedError(BOT_FILES_NOT_MOVED, { cause: error });
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
    if (from.scope !== "team" && OWN_ROOT_SKIPPED.has(file.path.replace(/\/.*/, ""))) continue;
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
    .filter((name) => !name.startsWith(".") && !OWN_ROOT_SKIPPED.has(name));
}

interface HomeAccess {
  releaseScreen(): Promise<void>;
  write(file: PortableFile): Promise<void>;
  verify(files: ReadonlyArray<{ path: string; size: number }>): Promise<void>;
  removeFiles(paths: readonly string[]): Promise<void>;
  removeEntries(entries: readonly Entry[]): Promise<void>;
}

/**
 * Work on a computer's home: a running one through the computer itself, since its bots could
 * swap a folder for a link under the server; a stopped one on the server, holding its row so it
 * cannot start meanwhile. Any other state (starting, stopping) refuses.
 */
async function onComputer<T>(
  deps: ComputerMoveDeps,
  computer: MovingComputer,
  context: AdapterContext,
  work: (access: HomeAccess) => Promise<T>,
): Promise<T> {
  const root = resolveAgentHomePath(deps.home, computer.homeKey, deps.dataDir);
  const current = await deps.prisma.computer.findUniqueOrThrow({
    where: { id: computer.id },
    select: { state: true, providerRef: true },
  });
  if (current.state === "running" && current.providerRef) {
    return work(
      runningHome(deps, { ...computer, providerRef: current.providerRef }, root, context),
    );
  }
  return deps.prisma.$transaction(
    async (tx) => {
      const [row] = await tx.$queryRaw<Array<{ state: string }>>`
        SELECT state FROM computers WHERE id = ${computer.id} FOR UPDATE`;
      if (row?.state !== "stopped") throw new BotFilesNotMovedError();
      return work(stoppedHome(deps, computer, root));
    },
    { maxWait: 10_000, timeout: STOPPED_HOLD_MS },
  );
}

function runningHome(
  deps: ComputerMoveDeps,
  computer: MovingComputer,
  root: string,
  context: AdapterContext,
): HomeAccess {
  const ref = toComputerRef(computer);
  return {
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

function stoppedHome(deps: ComputerMoveDeps, computer: MovingComputer, root: string): HomeAccess {
  return {
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
