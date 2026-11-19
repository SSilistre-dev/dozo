import type { RealtimeFanout } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import { ComputerLimitError, ensureComputerRecord } from "./computers.js";
import {
  changeSiteSettings,
  DOZO_SITE_SETTINGS_UNSET,
  followSiteChanges,
  publishSiteChange,
  readSiteSettings,
  signupsOpenFrom,
  siteMaxComputersPerUser,
  siteSignupPolicy,
} from "./dozo-site-settings.js";

/**
 * The table's one row and the security events, read and written with the SQL the module sends.
 * A transaction commits both or neither, as Postgres does.
 */
function table(initial?: Record<string, unknown>) {
  let row = initial;
  const events: Record<string, unknown>[] = [];
  const sql = (strings: TemplateStringsArray) => strings.join("?");
  const failEvent = { next: false };
  const client = {
    $queryRaw: vi.fn(async (strings: TemplateStringsArray) =>
      sql(strings).includes('FROM "dozo_site_settings"') && row ? [{ ...row }] : [],
    ),
    $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const text = sql(strings);
      if (text.startsWith("\n      INSERT")) row ??= {};
      else if (text.includes("UPDATE")) {
        const [signupsOpen, maxComputersPerUser, announcementEn, announcementTr, by] = values;
        row = { signupsOpen, maxComputersPerUser, announcementEn, announcementTr, by };
      }
      return 1;
    }),
    securityEvent: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (failEvent.next) throw new Error("security_events is unavailable");
        events.push(data);
        return data;
      }),
    },
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => {
      const [rowBefore, eventsBefore] = [row, events.length];
      try {
        return await work(client);
      } catch (error) {
        row = rowBefore;
        events.length = eventsBefore;
        throw error;
      }
    }),
  };
  return {
    client: client as unknown as PrismaClient,
    row: () => row,
    events,
    failEvent,
    raw: client,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reading the settings", () => {
  it("follows the environment for everything before an admin saved anything", async () => {
    expect(await readSiteSettings(table().client)).toEqual(DOZO_SITE_SETTINGS_UNSET);
  });

  it("reads what was saved, and leaves a value of another shape to the environment", async () => {
    const saved = { signupsOpen: false, maxComputersPerUser: 3, announcementEn: "Hi" };
    expect(await readSiteSettings(table(saved).client)).toEqual({
      ...DOZO_SITE_SETTINGS_UNSET,
      ...saved,
    });
    const odd = { signupsOpen: "no", maxComputersPerUser: -1, announcementTr: "" };
    expect(await readSiteSettings(table(odd).client)).toEqual(DOZO_SITE_SETTINGS_UNSET);
    expect(
      (await readSiteSettings(table({ maxComputersPerUser: 1.5 }).client)).maxComputersPerUser,
    ).toBeNull();
  });
});

describe("changing the settings", () => {
  it("sets what the change names, keeps the rest, and answers before and after", async () => {
    const { client, row, raw } = table({ signupsOpen: false, announcementEn: "Old" });
    const result = await changeSiteSettings(
      client,
      { maxComputersPerUser: 2, announcementEn: undefined, announcementTr: "Yeni" },
      "admin-1",
    );
    expect(result.before).toEqual({
      ...DOZO_SITE_SETTINGS_UNSET,
      signupsOpen: false,
      announcementEn: "Old",
    });
    expect(result.after).toEqual({
      signupsOpen: false,
      maxComputersPerUser: 2,
      announcementEn: "Old",
      announcementTr: "Yeni",
    });
    expect(row()).toMatchObject({ ...result.after, by: "admin-1" });
    // One transaction, and the row is read under its lock.
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
    expect(raw.$queryRaw.mock.calls[0]?.[0].join("")).toContain("FOR UPDATE");
  });

  it("creates the row on the first save and returns a setting to the environment with null", async () => {
    const { client, row } = table();
    await changeSiteSettings(client, { signupsOpen: true }, "admin-1");
    expect(row()).toMatchObject({ signupsOpen: true, maxComputersPerUser: null });
    const { after } = await changeSiteSettings(client, { signupsOpen: null }, "admin-1");
    expect(after.signupsOpen).toBeNull();
  });
});

describe("the audit trail of a change", () => {
  it("records each changed setting in the change's own transaction: who, which, from and to", async () => {
    const { client, events, raw } = table({ signupsOpen: false, announcementEn: "Hi" });
    await changeSiteSettings(
      client,
      { signupsOpen: true, announcementEn: "Hi", maxComputersPerUser: 2 },
      "admin-1",
    );
    expect(events).toEqual([
      expect.objectContaining({
        type: "deployment.settings.changed",
        userId: "admin-1",
        metadata: { setting: "signupsOpen", from: false, to: true },
      }),
      expect.objectContaining({
        type: "deployment.settings.changed",
        userId: "admin-1",
        metadata: { setting: "maxComputersPerUser", from: null, to: 2 },
      }),
    ]);
    // The unchanged announcement is not recorded; all of it was one transaction.
    expect(raw.$transaction).toHaveBeenCalledTimes(1);
  });

  it("leaves no change behind when its record cannot be written", async () => {
    const { client, events, failEvent, row } = table({ signupsOpen: false });
    failEvent.next = true;
    await expect(changeSiteSettings(client, { signupsOpen: true }, "admin-1")).rejects.toThrow(
      "security_events is unavailable",
    );
    expect(row()).toEqual({ signupsOpen: false });
    expect(events).toEqual([]);
  });
});

/** A fanout with one process's subscribers, as the in-memory adapter has it. */
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
  } as unknown as RealtimeFanout & { publish: ReturnType<typeof vi.fn> };
}

describe("the live signal", () => {
  it("signals once when following starts and once per change, with no content", async () => {
    const realtime = fanout();
    const controller = new AbortController();
    const signals = followSiteChanges(realtime, controller.signal);
    await signals.next();
    publishSiteChange(realtime);
    await vi.waitFor(() => expect(realtime.publish).toHaveBeenCalledWith(expect.any(String), ""));
    await signals.next();
    controller.abort();
    expect((await signals.next()).done).toBe(true);
  });

  it("tells nobody without a fanout, and logs a publish that keeps failing", async () => {
    expect(() => publishSiteChange(undefined)).not.toThrow();
    const realtime = fanout();
    realtime.publish.mockRejectedValue(new Error("not a database outage"));
    publishSiteChange(realtime);
    await vi.waitFor(() => expect(realtime.publish).toHaveBeenCalled());
  });
});

describe("the computer quota on the branded tree", () => {
  // Upstream's own tests expect no SQL read when SANDBOX_MAX_COMPUTERS_PER_USER is unset. On the
  // branded tree the quota reads the admin's cap first, so this pins the new behaviour.
  const input = {
    mode: "dedicated" as const,
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    kind: "docker",
  };
  function quotaClient(site: Record<string, unknown> | undefined, inUse: number) {
    return {
      // A transaction client: SQL, no $transaction of its own.
      // The quota lock arrives as a built statement rather than a template.
      $queryRaw: vi.fn(async (strings: TemplateStringsArray | object) =>
        Array.isArray(strings) && strings.join("").includes("dozo_site_settings")
          ? site
            ? [site]
            : []
          : [{ lock: "1" }],
      ),
      computer: {
        findUnique: vi.fn(async () => null),
        count: vi.fn(async () => inUse),
        upsert: vi.fn(async () => ({ id: "computer-1" })),
      },
    } as unknown as PrismaClient;
  }

  it("refuses a computer over the admin's cap while the environment sets none", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "");
    await expect(
      ensureComputerRecord(quotaClient({ maxComputersPerUser: 1 }, 1), input),
    ).rejects.toBeInstanceOf(ComputerLimitError);
  });

  it("lifts the environment's cap when the admin set none (0)", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
    const client = quotaClient({ maxComputersPerUser: 0 }, 5);
    await expect(ensureComputerRecord(client, input)).resolves.toEqual({ id: "computer-1" });
  });

  it("follows the environment's cap when the admin set nothing", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "1");
    await expect(ensureComputerRecord(quotaClient(undefined, 1), input)).rejects.toBeInstanceOf(
      ComputerLimitError,
    );
  });
});

describe("what the settings decide", () => {
  it("lets the admin's sign-up choice win over the environment, either way", () => {
    const set = (signupsOpen: boolean | null) => ({ ...DOZO_SITE_SETTINGS_UNSET, signupsOpen });
    expect(signupsOpenFrom(set(true), "false")).toBe(true);
    expect(signupsOpenFrom(set(false), undefined)).toBe(false);
    expect(signupsOpenFrom(set(null), "false")).toBe(false);
    expect(signupsOpenFrom(set(null), "0")).toBe(false);
    expect(signupsOpenFrom(set(null), undefined)).toBe(true);
  });

  it("gives the auth the environment's allowlist with the sign-up switch in force", async () => {
    const env = { signupsEnabled: "false", signupAllowlist: "@example.test" };
    expect(await siteSignupPolicy(table().client, env)).toEqual({
      enabled: false,
      allowlist: ["@example.test"],
    });
    expect(await siteSignupPolicy(table({ signupsOpen: true }).client, env)).toEqual({
      enabled: true,
      allowlist: ["@example.test"],
    });
  });

  it("caps computers per person as the admin set, else as the environment says", async () => {
    vi.stubEnv("SANDBOX_MAX_COMPUTERS_PER_USER", "4");
    expect(await siteMaxComputersPerUser(table().client)).toBe(4);
    expect(await siteMaxComputersPerUser(table({ maxComputersPerUser: 1 }).client)).toBe(1);
    // 0 is the admin lifting the cap the environment sets.
    expect(await siteMaxComputersPerUser(table({ maxComputersPerUser: 0 }).client)).toBe(0);
    // A client that cannot run SQL has no setting to read.
    expect(await siteMaxComputersPerUser({ computer: {} })).toBe(4);
  });
});
