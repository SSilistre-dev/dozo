import { afterEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "./client.js";
import {
  changeSiteSettings,
  DOZO_SITE_SETTINGS_UNSET,
  readSiteSettings,
  signupsOpenFrom,
  siteMaxComputersPerUser,
  siteSignupPolicy,
} from "./dozo-site-settings.js";

/** The table's one row, read and written with the SQL the module sends. */
function table(initial?: Record<string, unknown>) {
  let row = initial;
  const sql = (strings: TemplateStringsArray) => strings.join("?");
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
    $transaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(client)),
  };
  return { client: client as unknown as PrismaClient, row: () => row, raw: client };
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
