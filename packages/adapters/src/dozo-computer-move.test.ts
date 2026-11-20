import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamBrowserProfileName } from "./computer-workspace.js";
import type { MovingComputer } from "./dozo-computer-move.js";
import {
  BOT_FILES_NOT_MOVED,
  BOT_FILES_TOO_LARGE,
  BOT_FILES_UNMOVABLE,
  BotFilesNotMovedError,
  MAX_MOVED_FILE_BYTES,
  moveBotComputerFiles,
  movesBotFiles,
  recoverBotComputerSwitch,
  switchDueKey,
} from "./dozo-computer-move.js";
import { LocalAgentHomeStore } from "./home.js";
import { knownSandboxKinds } from "./sandbox-kind-capabilities.js";

const A = "botalpha";
const B = "botbeta";
const profile = `.browser-profiles/${teamBrowserProfileName(A)}`;
const otherProfile = `.browser-profiles/${teamBrowserProfileName(B)}`;

type Row = MovingComputer & { state: string; maintenanceId: string | null; scopeKey: string };
type BotRow = {
  spaceId: string;
  userId: string;
  computerId: string;
  computerSwitching: boolean;
  updatedAt: Date;
};
const computerRow = (row: Omit<Row, "maintenanceId">): Row => ({ ...row, maintenanceId: null });

let dir: string;
let home: LocalAgentHomeStore;
let computers: Record<string, Row>;
let bots: Record<string, BotRow>;
let due: string[];
let sandbox: SandboxProvider & { written: string[] };
const context = { signal: new AbortController().signal, spaceId: "space" } as AdapterContext;

const team = () => computers.team as Row;
const own = () => computers.own as Row;
const botA = () => bots[A] as BotRow;
const teamPath = (relative = "") => path.join(home.pathFor("home-team"), relative);
const ownPath = (relative = "") => path.join(home.pathFor("home-own"), relative);

async function put(file: string, content: string | Buffer = "x") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const matches = (row: object, where: Record<string, unknown>) =>
  Object.entries(where).every(([key, value]) => (row as Record<string, unknown>)[key] === value);

const prisma = () =>
  ({
    computer: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => computers[where.id],
      findUnique: async ({ where }: { where: { scopeKey: string } }) =>
        Object.values(computers).find((row) => row.scopeKey === where.scopeKey) ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: Record<string, unknown>;
        data: Record<string, unknown>;
      }) => {
        const rows = Object.values(computers).filter((row) => matches(row, where));
        for (const row of rows) Object.assign(row, data);
        return { count: rows.length };
      },
    },
    bot: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        const bot = bots[where.id];
        return bot && { ...bot, computer: { scope: computers[bot.computerId]?.scope } };
      },
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; updatedAt: Date };
        data: Record<string, unknown>;
      }) => {
        const bot = bots[where.id];
        if (!bot || bot.updatedAt !== where.updatedAt) return { count: 0 };
        Object.assign(bot, data);
        return { count: 1 };
      },
    },
    spaceMember: { findFirst: async () => ({ userId: "owner" }) },
    $executeRaw: async (_sql: TemplateStringsArray, key: string) => {
      due.push(key);
      return 1;
    },
  }) as unknown as PrismaClient;

const deps = () => ({ prisma: prisma(), sandbox, home });

/** Switch the bot the way the API does: its computer changes only in `flip`. */
const move = (
  from: MovingComputer,
  to: MovingComputer,
  options: { botId?: string; flip?: () => Promise<string>; signal?: AbortSignal } = {},
) => {
  const botId = options.botId ?? A;
  const flip =
    options.flip ??
    (async () => {
      const bot = bots[botId];
      if (bot) bot.computerId = to.id;
      return "switched";
    });
  return moveBotComputerFiles(
    deps(),
    { botId, from, to, flip },
    { ...context, signal: options.signal ?? context.signal },
  );
};

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dozo-move-"));
  home = new LocalAgentHomeStore(dir);
  computers = {
    team: computerRow({
      id: "team",
      homeKey: "home-team",
      kind: "docker",
      providerRef: "c-team",
      scope: "team",
      state: "stopped",
      scopeKey: "team:space:owner",
    }),
    own: computerRow({
      id: "own",
      homeKey: "home-own",
      kind: "docker",
      providerRef: null,
      scope: "dedicated",
      state: "stopped",
      scopeKey: `bot:${A}`,
    }),
  };
  bots = {
    [A]: {
      spaceId: "space",
      userId: "owner",
      computerId: "team",
      computerSwitching: true,
      updatedAt: new Date(Date.now() - 60 * 60_000),
    },
  };
  due = [];
  // A running Team Computer works in the server's home directory, as Docker's does.
  const written: string[] = [];
  sandbox = {
    written,
    writeFile: vi.fn(async (_ref: unknown, file: PortableFile) => {
      written.push(file.path);
      await put(teamPath(file.path), Buffer.from(file.content));
    }),
    workspaceDirectories: vi.fn(
      async (_ref: unknown, request: { parent: string; names: string[] }) => {
        for (const name of request.names) {
          await rm(teamPath(`${request.parent}/${name}`), { recursive: true, force: true });
        }
        return [];
      },
    ),
    releaseScreen: vi.fn(async () => {}),
    execute: vi.fn(async function* (_ref: unknown, request: { argv: string[] }) {
      for (const file of request.argv.slice(3)) await rm(teamPath(file), { force: true });
      yield { type: "exit" as const, code: 0 };
    }),
  } as unknown as SandboxProvider & { written: string[] };
  await put(teamPath(`bots/${A}/notes.txt`), "alpha notes");
  await put(teamPath(`bots/${A}/project/run.sh`), "echo hi");
  await chmod(teamPath(`bots/${A}/project/run.sh`), 0o755);
  await put(teamPath(`${profile}/Default/Cookies`), "alpha cookies");
  await put(teamPath(`${profile}/Default/Cache/data_0`), "cache");
  await put(teamPath(`bots/${B}/notes.txt`), "beta notes");
  await put(teamPath(`${otherProfile}/Default/Cookies`), "beta cookies");
  await put(teamPath("shared/plan.md"), "shared");
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});

describe("moving a bot's files when it switches computers", () => {
  it("to its own computer: its folder and profile arrive there and leave the Team Computer", async () => {
    await expect(move(team(), own())).resolves.toBe("switched");
    expect(botA().computerId).toBe("own");
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(await readFile(ownPath("project/run.sh"), "utf8")).toBe("echo hi");
    expect((await stat(ownPath("project/run.sh"))).mode & 0o100).toBe(0o100);
    expect(await readFile(ownPath(`${profile}/Default/Cookies`), "utf8")).toBe("alpha cookies");
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
    expect(existsSync(teamPath(profile))).toBe(false);
    // The other bot and shared/ are not the moving bot's.
    expect(await readFile(teamPath(`bots/${B}/notes.txt`), "utf8")).toBe("beta notes");
    expect(existsSync(teamPath(otherProfile))).toBe(true);
    expect(existsSync(teamPath("shared/plan.md"))).toBe(true);
    expect(existsSync(ownPath("shared"))).toBe(false);
    // Both computers were held while their homes changed, and are free again.
    expect(team().maintenanceId).toBeNull();
    expect(own().maintenanceId).toBeNull();
  });

  it("back to the Team Computer: the same files return under its folder, and leave its own", async () => {
    // Folders named like the Team Computer's own go there and back like any other.
    await put(teamPath(`bots/${A}/shared/mine.md`), "the bot's own shared folder");
    await put(teamPath(`bots/${A}/bots/list.md`), "the bot's own bots folder");
    await move(team(), own());
    await put(ownPath(".config/app.json"), "{}");
    await put(ownPath("later.txt"), "written on its own computer");
    await move(own(), team());
    expect(botA().computerId).toBe("team");
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(await readFile(teamPath(`bots/${A}/later.txt`), "utf8")).toBe(
      "written on its own computer",
    );
    expect(await readFile(teamPath(`bots/${A}/shared/mine.md`), "utf8")).toContain("own shared");
    expect(await readFile(teamPath(`bots/${A}/bots/list.md`), "utf8")).toContain("own bots");
    expect(await readFile(teamPath(`${profile}/Default/Cookies`), "utf8")).toBe("alpha cookies");
    for (const name of ["notes.txt", "project", "shared", "bots", profile]) {
      expect(existsSync(ownPath(name))).toBe(false);
    }
    // Its own settings stay on its own computer.
    expect(existsSync(ownPath(".config/app.json"))).toBe(true);
    expect(existsSync(teamPath(`bots/${A}/.config`))).toBe(false);
  });

  it("through a running Team Computer: closes the bot's browser, writes and removes there", async () => {
    team().state = "running";
    await move(team(), own());
    expect(sandbox.releaseScreen).toHaveBeenCalledOnce();
    expect(sandbox.workspaceDirectories).toHaveBeenCalledTimes(2);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(team().maintenanceId).toBeNull();

    await move(own(), team());
    expect(sandbox.written).toContain(`bots/${A}/notes.txt`);
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
  });

  it("never carries what a link, a hard link or a pipe in the bot's folder points at", async () => {
    const folder = teamPath(`bots/${A}`);
    await symlink("/etc", path.join(folder, "etc"));
    await symlink("/etc/hostname", path.join(folder, "hostname"));
    await symlink(`../${B}`, path.join(folder, "beta"));
    await link(teamPath(`bots/${B}/notes.txt`), path.join(folder, "linked.txt"));
    execFileSync("mkfifo", [path.join(folder, "pipe")]);
    await move(team(), own());
    expect(existsSync(ownPath("etc"))).toBe(false);
    expect(existsSync(ownPath("hostname"))).toBe(false);
    expect(existsSync(ownPath("beta"))).toBe(false);
    expect(existsSync(ownPath("pipe"))).toBe(false);
    // A hard link is the bot's own file; the other name of it stays with the other bot.
    expect(await readFile(ownPath("linked.txt"), "utf8")).toBe("beta notes");
    expect(await readFile(teamPath(`bots/${B}/notes.txt`), "utf8")).toBe("beta notes");
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("refuses files over the limit before copying anything, and names them", async () => {
    await put(teamPath(`bots/${A}/videos/big.mp4`), Buffer.alloc(MAX_MOVED_FILE_BYTES + 1));
    // A browser cache the move leaves behind does not count.
    await put(teamPath(`${profile}/Default/Cache/huge`), Buffer.alloc(MAX_MOVED_FILE_BYTES + 1));
    const flip = vi.fn();
    await expect(move(team(), own(), { flip })).rejects.toThrow(
      `${BOT_FILES_TOO_LARGE}: videos/big.mp4`,
    );
    expect(flip).not.toHaveBeenCalled();
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/videos/big.mp4`))).toBe(true);
    expect(team().maintenanceId).toBeNull();
  });

  it("refuses a file that grew past the limit while it was copied", async () => {
    const exportHome = home.exportHome.bind(home);
    vi.spyOn(home, "exportHome").mockImplementation(async function* (...args) {
      for await (const file of exportHome(...args)) {
        yield { ...file, content: new Uint8Array(MAX_MOVED_FILE_BYTES + 1) };
      }
    });
    await expect(move(team(), own())).rejects.toThrow(BOT_FILES_TOO_LARGE);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("a copy that fails leaves nothing on the Team Computer and the files where they were", async () => {
    await move(team(), own());
    team().state = "running";
    let writes = 0;
    vi.mocked(sandbox.writeFile).mockImplementation(async (_ref, file) => {
      if (++writes === 3) throw new Error("disk full");
      await put(teamPath(file.path), Buffer.from(file.content));
    });
    const failed = await move(own(), team()).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BotFilesNotMovedError);
    expect((failed as Error).message).toBe(BOT_FILES_NOT_MOVED);
    expect(botA().computerId).toBe("own");
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/project/run.sh`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(existsSync(ownPath(profile))).toBe(true);
  });

  it("a stopped Team Computer that cannot take a file keeps none of the ones before it", async () => {
    await move(team(), own());
    await mkdir(teamPath(`${profile}/Default/Cookies`), { recursive: true });
    await expect(move(own(), team())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/project/run.sh`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("an Own computer that cannot take a file keeps none of the ones before it", async () => {
    await mkdir(ownPath(`${profile}/Default/Cookies`), { recursive: true });
    await expect(move(team(), own())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(botA().computerId).toBe("team");
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
    expect(existsSync(ownPath("project/run.sh"))).toBe(false);
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
  });

  it("trying again after a copy that stopped part way finishes it, once", async () => {
    await mkdir(ownPath(`${profile}/Default/Cookies`), { recursive: true });
    await expect(move(team(), own())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    await rm(ownPath(profile), { recursive: true });
    await move(team(), own());
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(await readFile(ownPath(`${profile}/Default/Cookies`), "utf8")).toBe("alpha cookies");
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("a switch that fails after the copy takes the copy back", async () => {
    const flip = vi.fn().mockRejectedValue(new Error("database gone"));
    await expect(move(team(), own(), { flip })).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("a switch that lost its lease does not change the bot's computer", async () => {
    const lost = new AbortController();
    lost.abort(new Error("lease lost"));
    const flip = vi.fn();
    await expect(move(team(), own(), { flip, signal: lost.signal })).rejects.toThrow(
      BOT_FILES_NOT_MOVED,
    );
    expect(flip).not.toHaveBeenCalled();
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("a file that does not arrive whole fails the move before anything is deleted", async () => {
    await move(team(), own());
    team().state = "running";
    // Each file arrives empty, and taking them back fails too.
    vi.mocked(sandbox.writeFile).mockImplementation(async (_ref, file) => {
      await put(teamPath(file.path), "");
    });
    vi.mocked(sandbox.execute).mockImplementation(async function* () {
      yield { type: "stderr" as const, data: "busy" };
      yield { type: "exit" as const, code: 1 };
    });
    await expect(move(own(), team())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(botA().computerId).toBe("own");
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("switches even when the Team Computer cannot be cleared, and leaves that to the sweep", async () => {
    team().state = "running";
    vi.mocked(sandbox.workspaceDirectories!).mockRejectedValue(new Error("gone"));
    await expect(move(team(), own())).resolves.toBe("switched");
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(due).toEqual([switchDueKey(A)]);
  });

  it("keeps a copy its Own computer could not drop: it is private, and the switch stands", async () => {
    await move(team(), own());
    own().state = "running";
    own().providerRef = "c-own";
    await expect(move(own(), team())).resolves.toBe("switched");
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(due).toEqual([]);
  });

  it("refuses a folder another bot swapped for a link, writing nothing through it", async () => {
    await move(team(), own());
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await mkdir(teamPath("bots"), { recursive: true });
    await symlink(outside, teamPath(`bots/${A}`));
    await expect(move(own(), team())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(path.join(outside, "notes.txt"))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("refuses while a computer is starting, or held by another switch or an update", async () => {
    team().state = "booting";
    await expect(move(team(), own())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    team().state = "stopped";
    own().maintenanceId = "update-1";
    await expect(move(team(), own())).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(own().maintenanceId).toBe("update-1");
    expect(team().maintenanceId).toBeNull();
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("two bots joining one stopped Team Computer at once: one moves, the other is refused", async () => {
    const C = "botgamma";
    const gammaPath = path.join(home.pathFor("home-own-c"), "gamma.txt");
    computers.ownC = computerRow({
      id: "ownC",
      homeKey: "home-own-c",
      kind: "docker",
      providerRef: null,
      scope: "dedicated",
      state: "stopped",
      scopeKey: `bot:${C}`,
    });
    await move(team(), own());
    await put(gammaPath, "gamma");
    const results = await Promise.allSettled([
      move(own(), team()),
      move(computers.ownC as Row, team(), { botId: C }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(team().maintenanceId).toBeNull();
    const aMoved = existsSync(teamPath(`bots/${A}/notes.txt`));
    const cMoved = existsSync(teamPath(`bots/${C}/gamma.txt`));
    expect(aMoved).not.toBe(cMoved);
    // The refused bot keeps its files where they were.
    expect(existsSync(aMoved ? gammaPath : ownPath("notes.txt"))).toBe(true);
  });

  it("refuses on a computer that keeps its files elsewhere, unless it never started", async () => {
    const remote = { ...team(), kind: "e2b" };
    const flip = vi.fn(async () => "switched");
    await expect(move(remote, own(), { flip })).rejects.toThrow(BOT_FILES_UNMOVABLE);
    expect(flip).not.toHaveBeenCalled();
    await expect(move({ ...remote, providerRef: null }, own(), { flip })).resolves.toBe("switched");
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("only Docker computers declare that they move a bot's files", () => {
    expect(knownSandboxKinds.filter(movesBotFiles)).toEqual(["docker"]);
  });

  it("moves nothing for a bot with no files yet", async () => {
    await rm(teamPath(), { recursive: true, force: true });
    await move(team(), own());
    await move(own(), team());
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("waits for the browser to let go of its profile", async () => {
    team().state = "running";
    vi.mocked(sandbox.workspaceDirectories!)
      .mockRejectedValueOnce(new Error("rm: Device or resource busy"))
      .mockRejectedValueOnce(new Error("rm: Device or resource busy"));
    await move(team(), own());
    expect(sandbox.workspaceDirectories).toHaveBeenCalledTimes(4);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("only switches on the same computer, and refuses a bot id that is no folder name", async () => {
    await expect(move(team(), team())).resolves.toBe("switched");
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
    await expect(move(team(), own(), { botId: "../escape" })).rejects.toThrow(BOT_FILES_NOT_MOVED);
  });
});

describe("finishing a switch that stopped part way", () => {
  const recover = (staleMs = 60_000) => recoverBotComputerSwitch(deps(), A, context, staleMs);

  it("after the process died copying to the Team Computer: the copy goes, holds and flag clear", async () => {
    // The bot was still on its Own computer; part of its files had reached the Team Computer.
    botA().computerId = "own";
    team().maintenanceId = `dozo-move:${A}`;
    own().maintenanceId = `dozo-move:${A}`;
    await put(ownPath("notes.txt"), "alpha notes");
    await expect(recover()).resolves.toBe(true);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
    expect(existsSync(teamPath(profile))).toBe(false);
    expect(existsSync(teamPath(`bots/${B}/notes.txt`))).toBe(true);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(team().maintenanceId).toBeNull();
    expect(own().maintenanceId).toBeNull();
    expect(botA().computerSwitching).toBe(false);
  });

  it("clears a running Team Computer through the computer", async () => {
    botA().computerId = "own";
    team().state = "running";
    await expect(recover()).resolves.toBe(true);
    expect(sandbox.workspaceDirectories).toHaveBeenCalledTimes(2);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("leaves a bot on the Team Computer as it is: what its Own computer keeps is private", async () => {
    await put(ownPath("left.txt"), "a copy on its own computer");
    await expect(recover()).resolves.toBe(true);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
    expect(existsSync(ownPath("left.txt"))).toBe(true);
  });

  it("tries again later while the Team Computer is busy, or the flag may be a switch starting", async () => {
    botA().computerId = "own";
    team().state = "booting";
    await expect(recover()).resolves.toBe(false);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
    team().state = "stopped";
    botA().updatedAt = new Date();
    await expect(recover()).resolves.toBe(false);
    expect(botA().computerSwitching).toBe(true);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("has nothing to do for a bot that is gone, or one not switching", async () => {
    botA().computerSwitching = false;
    await expect(recover()).resolves.toBe(true);
    delete bots[A];
    await expect(recover()).resolves.toBe(true);
  });
});
