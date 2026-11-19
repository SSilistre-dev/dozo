import { createRouterClient } from "@orpc/server";
import type { RealtimeFanout } from "@rakazo/adapter-kit";
import type * as Adapters from "@rakazo/adapters";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { dozoAdminWiring } from "./dozo-admin.js";
import {
  DOZO_SITE_CHANGED,
  dozoSiteChanges,
  dozoSiteSettingsRoutes,
} from "./dozo-admin-settings.js";
import type { RouterDeps } from "./router.js";
import { createRouterContext } from "./routes/context.js";

// A provider that declares a memory read, standing in for the Docker host's.
const host = vi.hoisted(() => ({ memory: vi.fn() }));
vi.mock("@rakazo/adapters", async (original) => {
  const real = await original<typeof Adapters>();
  return {
    ...real,
    sandboxKindCapabilities: (kind: string | null | undefined) =>
      kind === "memory-host" ? { memory: host.memory } : real.sandboxKindCapabilities(kind),
  };
});

const users = [
  { id: "admin", email: "owner@example.test", emailVerified: true },
  { id: "ada", email: "ada@example.test", emailVerified: true },
];

/**
 * One database: the settings' row and the security events, read and written with the SQL and
 * calls the db package sends. A transaction commits both or neither.
 */
function database() {
  let row: Record<string, unknown> | undefined;
  const events: Record<string, unknown>[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) =>
        users.find((user) => user.id === where.id),
      ),
    },
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      sql(strings).includes("dozo_site_settings") && row ? [{ ...row }] : [],
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      if (sql(strings).includes("INSERT")) row ??= {};
      else {
        const [signupsOpen, maxComputersPerUser, announcementEn, announcementTr] = values;
        row = { signupsOpen, maxComputersPerUser, announcementEn, announcementTr };
      }
      return 1;
    }),
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        events.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const [rowBefore, eventsBefore] = [row, events.length];
      try {
        return await work(prisma);
      } catch (error) {
        row = rowBefore;
        events.length = eventsBefore;
        throw error;
      }
    }),
    events,
  };
  return prisma;
}

/** One API instance over `prisma`, as it is wired in the server. */
function instance(
  prisma: ReturnType<typeof database>,
  more: Partial<RouterDeps> = {},
  realtime?: RealtimeFanout,
) {
  const deps = {
    prisma,
    env: { adminEmails: ["owner@example.test"] },
    ...dozoAdminWiring({
      devices: {} as never,
      directoryProvisioning: false,
      signupsEnabled: "false",
      auth: {} as never,
      ...(realtime ? { realtime } : {}),
    }),
    ...more,
  } as unknown as RouterDeps;
  const ctx = createRouterContext(deps);
  return (userId: string) =>
    createRouterClient(dozoSiteSettingsRoutes(ctx), {
      context: {
        actor: { userId, spaceId: `space-${userId}`, email: "", isDeploymentOwner: false },
      },
    }).dozoSiteSettings;
}

beforeEach(() => {
  host.memory.mockReset();
  vi.unstubAllEnvs();
});

describe("who may read and change the site settings", () => {
  it("refuses anyone but an admin, before anything is read or written", async () => {
    const prisma = database();
    const as = instance(prisma);
    const refused = { code: "FORBIDDEN" };
    await expect(as("ada").get()).rejects.toMatchObject(refused);
    await expect(as("ada").update({ signupsOpen: true })).rejects.toMatchObject(refused);
    await expect(as("nobody").get()).rejects.toMatchObject(refused);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.events).toEqual([]);
  });

  it("shows everyone signed in the announcement, and nothing else", async () => {
    const prisma = database();
    const as = instance(prisma);
    expect(await as("ada").announcement()).toEqual({ en: null, tr: null });
    await as("admin").update({ announcementEn: "Back at 10:00", announcementTr: "" });
    expect(await as("ada").announcement()).toEqual({ en: "Back at 10:00", tr: null });
  });
});

describe("the settings", () => {
  it("follow the environment until an admin sets them, and again after a reset", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "3");
    const as = instance(database())("admin");
    expect(await as.get()).toEqual({
      signupsOpen: null,
      maxComputersPerUser: null,
      announcementEn: "",
      announcementTr: "",
      environment: { signupsOpen: false, maxComputersPerUser: 3 },
      memoryBudgetGb: null,
    });
    const saved = await as.update({ signupsOpen: true, maxComputersPerUser: 0 });
    expect(saved).toMatchObject({ signupsOpen: true, maxComputersPerUser: 0 });
    expect(saved.environment).toEqual({ signupsOpen: false, maxComputersPerUser: 3 });
    const reset = await as.update({ signupsOpen: null, maxComputersPerUser: null });
    expect(reset).toMatchObject({ signupsOpen: null, maxComputersPerUser: null });
  });

  it("carry nothing secret: only the settings and what the environment says of them", async () => {
    const settings = await instance(database())("admin").get();
    expect(Object.keys(settings).sort()).toEqual([
      "announcementEn",
      "announcementTr",
      "environment",
      "maxComputersPerUser",
      "memoryBudgetGb",
      "signupsOpen",
    ]);
    expect(Object.keys(settings.environment).sort()).toEqual([
      "maxComputersPerUser",
      "signupsOpen",
    ]);
  });

  it("show the computer host's memory budget, read only", async () => {
    host.memory.mockResolvedValue({ usedGb: 2, totalGb: 12 });
    const as = instance(database(), {
      sandbox: { describe: () => ({ id: "memory-host" }) },
    } as never)("admin");
    expect((await as.get()).memoryBudgetGb).toBe(12);
    // A host that does not answer leaves the figure out; the page still loads.
    host.memory.mockRejectedValue(new Error("unreachable"));
    expect((await as.get()).memoryBudgetGb).toBeNull();
  });

  it.each([
    ["an announcement over 200 characters", { announcementEn: "x".repeat(201) }],
    ["an announcement of two lines", { announcementTr: "one\ntwo" }],
    ["a tab", { announcementEn: "a\tb" }],
    ["a line separator", { announcementEn: "a\u2028b" }],
    ["a paragraph separator", { announcementEn: "a\u2029b" }],
    ["a right-to-left override", { announcementEn: "pay \u202Eexe.txt" }],
    ["a bidirectional isolate", { announcementTr: "a\u2066b\u2069" }],
    ["a zero-width space", { announcementEn: "a\u200Bb" }],
    ["a byte order mark", { announcementEn: "h\uFEFFi" }],
    ["a negative cap", { maxComputersPerUser: -1 }],
    ["a cap that is not whole", { maxComputersPerUser: 1.5 }],
    ["a cap over 1000", { maxComputersPerUser: 1001 }],
    ["a sign-up switch that is not a boolean", { signupsOpen: "yes" }],
  ])("refuse %s on the server, and write nothing", async (_what, input) => {
    const prisma = database();
    await expect(instance(prisma)("admin").update(input as never)).rejects.toMatchObject({
      code: "BAD_REQUEST",
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.events).toEqual([]);
  });

  it("store an announcement trimmed, and an empty one as none", async () => {
    const as = instance(database())("admin");
    expect((await as.update({ announcementEn: "  Maintenance tonight  " })).announcementEn).toBe(
      "Maintenance tonight",
    );
    expect((await as.update({ announcementEn: "   " })).announcementEn).toBe("");
    expect(await as.announcement()).toEqual({ en: null, tr: null });
  });
});

const audited = (prisma: ReturnType<typeof database>) =>
  prisma.events.map((event) => ({ userId: event.userId, metadata: event.metadata }));

describe("the audit trail", () => {
  it("records each change: who, which setting, from and to", async () => {
    const prisma = database();
    const as = instance(prisma)("admin");
    await as.update({ signupsOpen: false, announcementEn: "Hi" });
    await as.update({ signupsOpen: true, announcementEn: "Hi" });
    expect(prisma.events.every((event) => event.type === "deployment.settings.changed")).toBe(true);
    expect(audited(prisma)).toEqual([
      { userId: "admin", metadata: { setting: "signupsOpen", from: null, to: false } },
      { userId: "admin", metadata: { setting: "announcementEn", from: null, to: "Hi" } },
      // The unchanged announcement is not recorded again.
      { userId: "admin", metadata: { setting: "signupsOpen", from: false, to: true } },
    ]);
  });

  it("keeps no change whose record cannot be written, and tells nobody", async () => {
    const prisma = database();
    const realtime = fanout();
    const as = instance(prisma, {}, realtime)("admin");
    prisma.securityEvent.create.mockRejectedValueOnce(new Error("security_events is down"));
    await expect(as.update({ signupsOpen: true })).rejects.toBeTruthy();
    expect((await as.get()).signupsOpen).toBeNull();
    expect(realtime.publish).not.toHaveBeenCalled();
  });
});

/** A fanout with one process's subscribers. */
function fanout() {
  const listeners = new Map<string, Set<(payload: string) => void>>();
  return {
    describe: () => ({ id: "memory", capabilities: { distributed: false, push: true } }),
    publish: vi.fn(async (topic: string, payload: string) => {
      for (const listener of listeners.get(topic) ?? []) listener(payload);
    }),
    subscribe: vi.fn(async (topic: string, onMessage: (payload: string) => void) => {
      const set = listeners.get(topic) ?? new Set();
      set.add(onMessage);
      listeners.set(topic, set);
      return async () => {
        set.delete(onMessage);
      };
    }),
    close: vi.fn(async () => undefined),
  } as unknown as RealtimeFanout & {
    publish: ReturnType<typeof vi.fn>;
    subscribe: ReturnType<typeof vi.fn>;
  };
}

describe("the live stream", () => {
  it("signals open apps after a change commits, and not after a save that changed nothing", async () => {
    const realtime = fanout();
    const as = instance(database(), {}, realtime)("admin");
    const deps = { dozoAdmin: { realtime } } as unknown as RouterDeps;
    const controller = new AbortController();
    const stream = dozoSiteChanges(deps, controller.signal);
    // One signal when the stream opens: the reconnect is the catch-up.
    expect((await stream.next()).value).toBe(DOZO_SITE_CHANGED);
    await as.update({ announcementEn: "Back at 10:00" });
    expect(realtime.publish).toHaveBeenCalledWith(expect.any(String), "");
    expect((await stream.next()).value).toBe(DOZO_SITE_CHANGED);
    realtime.publish.mockClear();
    await as.update({ announcementEn: "Back at 10:00" });
    expect(realtime.publish).not.toHaveBeenCalled();
    controller.abort();
    expect((await stream.next()).done).toBe(true);
  });

  it("carries nothing without a fanout, and ends the stream when following fails", async () => {
    const quiet = dozoSiteChanges({} as RouterDeps, new AbortController().signal);
    expect((await quiet.next()).done).toBe(true);
    const realtime = fanout();
    realtime.subscribe.mockRejectedValue(new Error("listener down"));
    const controller = new AbortController();
    controller.abort();
    const failing = dozoSiteChanges(
      { dozoAdmin: { realtime } } as unknown as RouterDeps,
      controller.signal,
    );
    await expect(failing.next()).rejects.toBeTruthy();
  });
});

describe("several API instances", () => {
  it("agree at once: a change saved through one is what every other reads next", async () => {
    const prisma = database();
    const first = instance(prisma);
    const second = instance(prisma);
    await second("admin").get();
    await first("admin").update({ maxComputersPerUser: 5, announcementTr: "Bakım" });
    expect(await second("admin").get()).toMatchObject({
      maxComputersPerUser: 5,
      announcementTr: "Bakım",
    });
    expect(await second("ada").announcement()).toEqual({ en: null, tr: "Bakım" });
    await second("admin").update({ maxComputersPerUser: null });
    expect((await first("admin").get()).maxComputersPerUser).toBeNull();
  });
});
