import { createRouterClient } from "@orpc/server";
import type { AdapterContext, ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import type * as Db from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoSiteSessionsRoutes } from "./dozo-site-sessions.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

const spies = vi.hoisted(() => ({
  lease: vi.fn(async (..._args: unknown[]) => ({ computerId: "computer-1" }) as unknown),
  leaseEnd: vi.fn(async (..._args: unknown[]) => undefined),
  audit: vi.fn(async (_input: unknown) => undefined),
  release: vi.fn(async (..._args: unknown[]) => true),
  take: vi.fn(async (_deps: unknown, _actor: unknown, _botId: string) => ({
    leaseId: "lease-1",
    expiresAt: "2026-11-19T12:00:00.000Z",
  })),
}));
vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof Db>()),
  recordAuditEvent: spies.audit,
}));
vi.mock("@rakazo/adapters", async (original) => ({
  ...(await original<typeof Adapters>()),
  acquireComputerExecutionLease: spies.lease,
  releaseComputerExecutionLease: spies.leaseEnd,
}));
vi.mock("./computer-control.js", async (original) => ({
  ...(await original<typeof import("./computer-control.js")>()),
  takeComputerControl: spies.take,
  releaseComputerControl: spies.release,
}));

const HOSTS = [
  { host: "example.com", created: 1_700_000_000_000, lastUsed: 1_700_000_100_000 },
  { host: "a.example.com", created: 1_700_000_000_000, lastUsed: 1_700_000_100_000 },
  { host: "notexample.com", created: 1_700_000_000_000, lastUsed: 1_700_000_000_000 },
  { host: "alice.github.io", created: 1_700_000_000_000, lastUsed: 1_700_000_000_000 },
  { host: "bob.github.io", created: 1_700_000_000_000, lastUsed: 1_700_000_000_000 },
];

function computer(over: Record<string, unknown> = {}) {
  return {
    id: "computer-1",
    kind: "docker",
    providerRef: "ref",
    state: "running",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlUserId: null,
    controlBotId: null,
    ...over,
  };
}

/** One Space's bot on a Docker computer, and a computer that answers the session script. */
function instance(
  botComputer: ReturnType<typeof computer> | null = computer(),
  openReply: unknown = { ok: true },
  hosts: { host: string; created: number | null; lastUsed: number | null }[] = HOSTS,
  options: { visited?: string[]; waiting?: boolean; deleteReplies?: unknown[] } = {},
) {
  const bots = [{ id: "bot-1", name: "Scout", spaceId: "space-ada", computer: botComputer }];
  const scripts: { op: string; hosts?: string[]; url?: string; botId?: string }[] = [];
  const deleteReplies = [...(options.deleteReplies ?? [])];
  const prisma = {
    run: {
      findFirst: vi.fn(async () => (options.waiting ? { id: "run-1", userId: "ada" } : null)),
    },
    bot: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId: string } }) => {
        const bot = bots.find((b) => b.id === where.id && b.spaceId === where.spaceId);
        return bot ? { ...bot, thread: null } : null;
      }),
    },
  };
  const sandbox = {
    async *execute(
      _computer: ComputerRef,
      command: { argv: string[] },
      ctx: AdapterContext,
    ): AsyncIterable<ProcessEvent> {
      const request = JSON.parse(command.argv.at(-1)!);
      scripts.push({ ...request, botId: ctx.botId });
      const reply =
        request.op === "list"
          ? {
              ok: true,
              hosts: hosts.map((host) => ({ ...host, value: "session-secret" })),
              visited: options.visited ?? hosts.map(({ host }) => host),
              storageKeys: [
                "https://alice.github.io/",
                "https://example.com/^0https://top.example",
              ],
            }
          : request.op === "delete"
            ? (deleteReplies.shift() ?? { ok: true, remaining: 0 })
            : openReply;
      yield { type: "stdout", data: JSON.stringify(reply) };
      yield { type: "exit", code: 0 };
    },
  };
  const deps = { prisma, sandbox } as unknown as RouterDeps;
  const ctx = createRouterContext(deps);
  const as = (userId: string, spaceId = `space-${userId}`) =>
    createRouterClient(dozoSiteSessionsRoutes(ctx), {
      context: { actor: { userId, spaceId, email: "", isDeploymentOwner: false } },
    }).dozoSiteSessions;
  return { as, scripts, bots };
}

beforeEach(() => {
  spies.audit.mockClear();
  spies.take.mockClear();
  spies.lease.mockClear();
  spies.leaseEnd.mockClear();
  spies.release.mockClear();
});

describe("who may see and end a bot's sessions", () => {
  it("refuses a bot of another Space before its computer is asked anything", async () => {
    const { as, scripts } = instance();
    const outsider = as("eve");
    await expect(outsider.list({ botId: "bot-1" })).rejects.toThrow();
    await expect(outsider.signOut({ botId: "bot-1", site: "example.com" })).rejects.toThrow();
    await expect(outsider.signOut({ botId: "bot-1" })).rejects.toThrow();
    await expect(outsider.signIn({ botId: "bot-1", url: "example.com" })).rejects.toThrow();
    expect(scripts).toEqual([]);
    expect(spies.take).not.toHaveBeenCalled();
    expect(spies.audit).not.toHaveBeenCalled();
  });

  it("refuses to end sessions while another person controls the screen", async () => {
    const { as, scripts } = instance(
      computer({
        controlHolder: "user",
        controlLeaseId: "lease-x",
        controlLeaseExpiresAt: new Date(Date.now() + 60_000),
        controlUserId: "bea",
        controlBotId: "bot-1",
      }),
    );
    await expect(as("ada").signOut({ botId: "bot-1", site: "example.com" })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(scripts).toEqual([]);
  });
});

describe("the sites", () => {
  it("lists sites with their times and nothing a cookie holds", async () => {
    const { as, scripts } = instance();
    const { sites } = await as("ada").list({ botId: "bot-1" });
    expect(sites.map(({ site }) => site).sort()).toEqual([
      "alice.github.io",
      "bob.github.io",
      "example.com",
      "notexample.com",
    ]);
    expect(sites.find(({ site }) => site === "example.com")).toEqual({
      site: "example.com",
      since: new Date(1_700_000_000_000).toISOString(),
      lastUsedAt: new Date(1_700_000_100_000).toISOString(),
    });
    expect(JSON.stringify(sites)).not.toContain("session-secret");
    expect(scripts[0]).toMatchObject({ op: "list", botId: "bot-1" });
  });

  it("gives no times for a site the browser has not saved yet", async () => {
    const fresh = [{ host: "fresh.example", created: null, lastUsed: null }];
    const { as } = instance(computer(), { ok: true }, fresh);
    expect(await as("ada").list({ botId: "bot-1" })).toEqual({
      sites: [{ site: "fresh.example", since: null, lastUsedAt: null }],
    });
  });

  it("shows nothing, and asks nothing, while the computer is stopped", async () => {
    const { as, scripts } = instance(computer({ state: "stopped" }));
    expect(await as("ada").list({ botId: "bot-1" })).toEqual({ sites: [] });
    await expect(as("ada").signOut({ botId: "bot-1" })).rejects.toMatchObject({
      message: "Start the computer first.",
    });
    expect(scripts).toEqual([]);
  });

  it("hides the list from a computer whose provider cannot read it", async () => {
    const { as, scripts } = instance(computer({ kind: "desktop" }));
    expect(await as("ada").list({ botId: "bot-1" })).toEqual({ sites: [] });
    expect(scripts).toEqual([]);
  });
});

describe("signing out", () => {
  it("ends one site's hosts only and records who did it", async () => {
    const { as, scripts } = instance();
    await as("ada").signOut({ botId: "bot-1", site: "alice.github.io" });
    expect(scripts.at(-1)).toMatchObject({
      op: "delete",
      hosts: ["alice.github.io", "www.alice.github.io"],
      storageKeys: ["https://alice.github.io/"],
    });
    // The bot cannot use its computer meanwhile, and gets it back afterwards.
    expect(spies.lease).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ computerId: "computer-1", botId: "bot-1" }),
    );
    expect(spies.leaseEnd).toHaveBeenCalledTimes(1);
    expect(spies.audit).toHaveBeenCalledTimes(1);
    expect(spies.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "computer.site.session_ended",
        actor: { type: "user", id: "ada" },
        spaceId: "space-ada",
        target: { type: "bot", id: "bot-1", label: "Scout" },
        metadata: { site: "alice.github.io" },
      }),
    );
  });

  it("refuses a site the browser has no session for, such as a public suffix", async () => {
    const { as, scripts } = instance();
    for (const site of ["github.io", "com", "example"]) {
      await expect(as("ada").signOut({ botId: "bot-1", site })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    }
    expect(scripts.filter(({ op }) => op === "delete")).toEqual([]);
  });

  it("ends every site at once", async () => {
    const { as, scripts } = instance();
    await as("ada").signOut({ botId: "bot-1" });
    expect(new Set(scripts.at(-1)!.hosts)).toEqual(
      new Set([
        "example.com",
        "a.example.com",
        "www.example.com",
        "notexample.com",
        "www.notexample.com",
        "alice.github.io",
        "www.alice.github.io",
        "bob.github.io",
        "www.bob.github.io",
      ]),
    );
    expect(spies.audit).toHaveBeenCalledTimes(4);
  });

  it("signs out of every site with cookies, trackers and unlisted ones included", async () => {
    const tracked = [...HOSTS, { host: "tracker.example", created: 1, lastUsed: 1 }];
    const { as, scripts } = instance(computer(), { ok: true }, tracked, {
      visited: ["example.com"],
    });
    expect((await as("ada").list({ botId: "bot-1" })).sites.map(({ site }) => site)).toEqual([
      "example.com",
    ]);
    await as("ada").signOut({ botId: "bot-1" });
    expect(scripts.at(-1)!.hosts).toEqual(
      expect.arrayContaining(["tracker.example", "alice.github.io", "example.com"]),
    );
  });

  it("records the sites already gone when a later part fails", async () => {
    const many = Array.from({ length: 3000 }, (_, i) => ({
      host: `site-${i}-with-a-longer-name.example${i % 7}.com`,
      created: 1,
      lastUsed: 1,
    }));
    const { as } = instance(computer(), { ok: true }, many, {
      deleteReplies: [
        { ok: true, remaining: 0 },
        { ok: true, remaining: 2 },
      ],
    });
    await expect(as("ada").signOut({ botId: "bot-1" })).rejects.toMatchObject({
      message: "Some sites could not be signed out. The list shows what is left.",
    });
    const recorded = spies.audit.mock.calls.length;
    expect(recorded).toBeGreaterThan(0);
    expect(recorded).toBeLessThan(7);
  });

  it("does not wait on a bot that is waiting for someone on its screen", async () => {
    const { as, scripts } = instance(computer(), { ok: true }, HOSTS, { waiting: true });
    await as("ada").signIn({ botId: "bot-1", url: "example.com" });
    await as("ada").signOut({ botId: "bot-1", site: "example.com" });
    expect(spies.lease).not.toHaveBeenCalled();
    expect(scripts.map(({ op }) => op)).toEqual(["open", "list", "delete"]);
  });

  it("waits for nothing and touches nothing while the bot is using its computer", async () => {
    const { as, scripts } = instance();
    const busy = Object.assign(new Error("Computer is busy"), { name: "ComputerBusyError" });
    spies.lease.mockRejectedValueOnce(busy);
    await expect(as("ada").signOut({ botId: "bot-1" })).rejects.toThrow("Computer is busy");
    spies.lease.mockRejectedValueOnce(busy);
    await expect(as("ada").signIn({ botId: "bot-1", url: "example.com" })).rejects.toThrow(
      "Computer is busy",
    );
    expect(scripts).toEqual([]);
    expect(spies.take).not.toHaveBeenCalled();
    expect(spies.audit).not.toHaveBeenCalled();
  });

  it("gives the computer back to the bot when signing out fails", async () => {
    const { as } = instance();
    await expect(as("ada").signOut({ botId: "bot-1", site: "nowhere.example" })).rejects.toThrow();
    expect(spies.leaseEnd).toHaveBeenCalledTimes(1);
  });
});

describe("signing in", () => {
  it("takes control for the caller and opens the address in that bot's browser", async () => {
    const { as, scripts } = instance();
    expect(await as("ada").signIn({ botId: "bot-1", url: "example.com/login" })).toEqual({
      leaseId: "lease-1",
      expiresAt: "2026-11-19T12:00:00.000Z",
    });
    expect(spies.take).toHaveBeenCalledWith(expect.anything(), expect.anything(), "bot-1");
    expect(scripts).toEqual([
      expect.objectContaining({ op: "open", url: "https://example.com/login", botId: "bot-1" }),
    ]);
  });

  it("hands control back when the site could not be opened", async () => {
    const { as } = instance(computer(), { ok: false, error: "no_browser" });
    await expect(as("ada").signIn({ botId: "bot-1", url: "example.com" })).rejects.toMatchObject({
      message: "The bot's browser is busy. Try again in a moment.",
    });
    expect(spies.release).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ userId: "ada" }),
      expect.objectContaining({ id: "computer-1" }),
      "bot-1",
    );
  });

  it("keeps control this person already held when the site could not be opened", async () => {
    const held = computer({
      controlHolder: "user",
      controlLeaseId: "lease-0",
      controlLeaseExpiresAt: new Date(Date.now() + 60_000),
      controlUserId: "ada",
      controlBotId: "bot-1",
    });
    const { as } = instance(held, { ok: false, error: "no_browser" });
    await expect(as("ada").signIn({ botId: "bot-1", url: "example.com" })).rejects.toThrow();
    expect(spies.release).not.toHaveBeenCalled();
    expect(spies.leaseEnd).toHaveBeenCalledTimes(1);
  });

  it("has nothing to hand back when the computer went away meanwhile", async () => {
    const { as, bots } = instance(computer(), { ok: false, error: "busy" });
    spies.take.mockImplementationOnce(async () => {
      bots[0]!.computer = null;
      return { leaseId: "lease-1", expiresAt: "2026-11-19T12:00:00.000Z" };
    });
    await expect(as("ada").signIn({ botId: "bot-1", url: "example.com" })).rejects.toThrow();
    expect(spies.release).not.toHaveBeenCalled();
  });

  it("opens nothing when control is refused", async () => {
    const { as, scripts } = instance();
    spies.take.mockRejectedValueOnce(new Error("Stop the bot first"));
    await expect(as("ada").signIn({ botId: "bot-1", url: "example.com" })).rejects.toThrow();
    expect(scripts).toEqual([]);
  });
});
