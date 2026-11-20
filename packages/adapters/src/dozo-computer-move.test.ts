import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, PortableFile, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { teamBrowserProfileName } from "./computer-workspace.js";
import type { MovingComputer } from "./dozo-computer-move.js";
import {
  BOT_FILES_NOT_MOVED,
  BOT_FILES_UNMOVABLE,
  BotFilesNotMovedError,
  moveBotComputerFiles,
} from "./dozo-computer-move.js";
import { LocalAgentHomeStore } from "./home.js";

const A = "botalpha";
const B = "botbeta";
const profile = `.browser-profiles/${teamBrowserProfileName(A)}`;
const otherProfile = `.browser-profiles/${teamBrowserProfileName(B)}`;

const team: MovingComputer = {
  id: "team",
  homeKey: "home-team",
  kind: "docker",
  providerRef: "c-team",
  scope: "team",
};
const own: MovingComputer = {
  id: "own",
  homeKey: "home-own",
  kind: "docker",
  providerRef: null,
  scope: "dedicated",
};

let dir: string;
let home: LocalAgentHomeStore;
let states: Record<string, { state: string; providerRef: string | null }>;
let sandbox: SandboxProvider & { written: string[] };
const context = { signal: new AbortController().signal, spaceId: "space" } as AdapterContext;

const teamPath = (relative = "") => path.join(home.pathFor(team.homeKey), relative);
const ownPath = (relative = "") => path.join(home.pathFor(own.homeKey), relative);

async function put(file: string, content = "x") {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

const prisma = () =>
  ({
    computer: {
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => states[where.id],
    },
    $transaction: async (work: (tx: unknown) => Promise<unknown>) =>
      work({
        $queryRaw: async (_sql: TemplateStringsArray, id: string) => [{ state: states[id]?.state }],
      }),
  }) as unknown as PrismaClient;

const move = (from: MovingComputer, to: MovingComputer) =>
  moveBotComputerFiles({ prisma: prisma(), sandbox, home }, { botId: A, from, to }, context);

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "dozo-move-"));
  home = new LocalAgentHomeStore(dir);
  states = {
    team: { state: "stopped", providerRef: "c-team" },
    own: { state: "stopped", providerRef: null },
  };
  // A running Team Computer works in the server's home directory, as Docker's does.
  const written: string[] = [];
  sandbox = {
    written,
    writeFile: vi.fn(async (_ref: unknown, file: PortableFile) => {
      written.push(file.path);
      await put(teamPath(file.path), Buffer.from(file.content).toString());
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
  await rm(dir, { recursive: true, force: true });
});

describe("moving a bot's files when it switches computers", () => {
  it("to its own computer: its folder and profile arrive there and leave the Team Computer", async () => {
    await move(team, own);
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
    expect(existsSync(ownPath("bots"))).toBe(false);
  });

  it("back to the Team Computer: the same files return under its folder, and leave its own", async () => {
    await move(team, own);
    await put(ownPath(".config/app.json"), "{}");
    await put(ownPath("later.txt"), "written on its own computer");
    await put(ownPath("shared/old.md"), "not the bot's own");
    await move(own, team);
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(await readFile(teamPath(`bots/${A}/later.txt`), "utf8")).toBe(
      "written on its own computer",
    );
    expect(await readFile(teamPath(`${profile}/Default/Cookies`), "utf8")).toBe("alpha cookies");
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
    expect(existsSync(ownPath("project"))).toBe(false);
    expect(existsSync(ownPath(profile))).toBe(false);
    // Its own settings stay on its own computer.
    expect(existsSync(ownPath(".config/app.json"))).toBe(true);
    expect(existsSync(teamPath(`bots/${A}/.config`))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/shared`))).toBe(false);
    expect(existsSync(ownPath("shared/old.md"))).toBe(true);
  });

  it("through a running Team Computer: closes the bot's browser, writes and removes there", async () => {
    states.team = { state: "running", providerRef: "c-team" };
    await move(team, own);
    expect(sandbox.releaseScreen).toHaveBeenCalledOnce();
    expect(sandbox.workspaceDirectories).toHaveBeenCalledTimes(2);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");

    await move(own, team);
    expect(sandbox.written).toContain(`bots/${A}/notes.txt`);
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(existsSync(ownPath("notes.txt"))).toBe(false);
  });

  it("a copy that fails leaves nothing on the Team Computer and the files where they were", async () => {
    await move(team, own);
    states.team = { state: "running", providerRef: "c-team" };
    let writes = 0;
    vi.mocked(sandbox.writeFile).mockImplementation(async (_ref, file) => {
      if (++writes === 3) throw new Error("disk full");
      await put(teamPath(file.path), Buffer.from(file.content).toString());
    });
    const failed = await move(own, team).catch((error: unknown) => error);
    expect(failed).toBeInstanceOf(BotFilesNotMovedError);
    expect((failed as Error).message).toBe(BOT_FILES_NOT_MOVED);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/project/run.sh`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
    expect(existsSync(ownPath(profile))).toBe(true);
  });

  it("refuses a folder another bot swapped for a link, writing nothing through it", async () => {
    await move(team, own);
    const outside = path.join(dir, "outside");
    await mkdir(outside);
    await mkdir(teamPath("bots"), { recursive: true });
    await symlink(outside, teamPath(`bots/${A}`));
    await expect(move(own, team)).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(path.join(outside, "notes.txt"))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("refuses while a computer is starting or stopping", async () => {
    states.team = { state: "booting", providerRef: "c-team" };
    await expect(move(team, own)).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("refuses on a computer that keeps its files elsewhere, unless it never started", async () => {
    const remote = { ...team, kind: "e2b" };
    await expect(move(remote, own)).rejects.toThrow(BOT_FILES_UNMOVABLE);
    await expect(move({ ...remote, providerRef: null }, own)).resolves.toBeUndefined();
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
  });

  it("a stopped Team Computer that cannot take a file keeps none of the ones before it", async () => {
    await move(team, own);
    await mkdir(teamPath(`${profile}/Default/Cookies`), { recursive: true });
    await expect(move(own, team)).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(false);
    expect(existsSync(teamPath(`bots/${A}/project/run.sh`))).toBe(false);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("a file that does not arrive whole fails the move before anything is deleted", async () => {
    await move(team, own);
    states.team = { state: "running", providerRef: "c-team" };
    // Each file arrives empty.
    vi.mocked(sandbox.writeFile).mockImplementation(async (_ref, file) => {
      await put(teamPath(file.path), "");
    });
    vi.mocked(sandbox.execute).mockImplementation(async function* () {
      yield { type: "stderr" as const, data: "busy" };
      yield { type: "exit" as const, code: 1 };
    });
    await expect(move(own, team)).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("keeps the copy when the computer it leaves cannot be cleared, so trying again finishes", async () => {
    await move(team, own);
    states.own = { state: "running", providerRef: "c-own" };
    await expect(move({ ...own, providerRef: "c-own" }, team)).rejects.toThrow(BOT_FILES_NOT_MOVED);
    expect(await readFile(teamPath(`bots/${A}/notes.txt`), "utf8")).toBe("alpha notes");
    expect(await readFile(ownPath("notes.txt"), "utf8")).toBe("alpha notes");
  });

  it("moves nothing for a bot with no files yet", async () => {
    await rm(teamPath(), { recursive: true, force: true });
    await move(team, own);
    await move(own, team);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("waits for the browser to let go of its profile", async () => {
    states.team = { state: "running", providerRef: "c-team" };
    vi.mocked(sandbox.workspaceDirectories!)
      .mockRejectedValueOnce(new Error("rm: Device or resource busy"))
      .mockRejectedValueOnce(new Error("rm: Device or resource busy"));
    await move(team, own);
    expect(sandbox.workspaceDirectories).toHaveBeenCalledTimes(4);
    expect(existsSync(teamPath(`bots/${A}`))).toBe(false);
  });

  it("does nothing on the same computer, and refuses a bot id that is no folder name", async () => {
    await move(team, team);
    expect(existsSync(teamPath(`bots/${A}/notes.txt`))).toBe(true);
    await expect(
      moveBotComputerFiles(
        { prisma: prisma(), sandbox, home },
        { botId: "../escape", from: team, to: own },
        context,
      ),
    ).rejects.toThrow(BOT_FILES_NOT_MOVED);
  });
});
