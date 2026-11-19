import { signupPolicyFromEnv, signupsOpen } from "@rakazo/core";
import type { PrismaClient } from "./client.js";
import { resolveMaxComputersPerUser } from "./computers.js";

type Read = Pick<PrismaClient, "$queryRaw">;
type Write = Pick<PrismaClient, "$transaction">;

/**
 * What an admin set on the admin page. Null follows what the environment says
 * (`SIGNUPS_ENABLED`, `SANDBOX_MAX_COMPUTERS_PER_USER`); an announcement has no environment
 * variable, so null is no announcement.
 */
export interface DozoSiteSettings {
  signupsOpen: boolean | null;
  /** 0 is no cap, as the environment variable has it. */
  maxComputersPerUser: number | null;
  announcementEn: string | null;
  announcementTr: string | null;
}

export const DOZO_SITE_SETTINGS_UNSET: DozoSiteSettings = {
  signupsOpen: null,
  maxComputersPerUser: null,
  announcementEn: null,
  announcementTr: null,
};

/** The audit names of the settings, in the order the page shows them. */
export const DOZO_SITE_SETTING_KEYS = [
  "signupsOpen",
  "maxComputersPerUser",
  "announcementEn",
  "announcementTr",
] as const satisfies readonly (keyof DozoSiteSettings)[];

type Row = Partial<Record<keyof DozoSiteSettings, unknown>>;

function settingsOf(row: Row | undefined): DozoSiteSettings {
  // A column the row lacks, or holds in another shape, follows the environment: never a guess.
  const bool = (value: unknown) => (typeof value === "boolean" ? value : null);
  const count = (value: unknown) =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
  const text = (value: unknown) => (typeof value === "string" && value !== "" ? value : null);
  return {
    signupsOpen: bool(row?.signupsOpen),
    maxComputersPerUser: count(row?.maxComputersPerUser),
    announcementEn: text(row?.announcementEn),
    announcementTr: text(row?.announcementTr),
  };
}

/**
 * The stored settings, read from the database on every call: every API instance answers from the
 * same row, so a change holds everywhere at once and there is nothing to refresh.
 */
export async function readSiteSettings(db: Read): Promise<DozoSiteSettings> {
  const rows = await db.$queryRaw<Row[]>`
    SELECT "signupsOpen", "maxComputersPerUser", "announcementEn", "announcementTr"
    FROM "dozo_site_settings" WHERE "id" = 'default'`;
  return settingsOf(rows[0]);
}

/**
 * Sets the settings `change` names (null returns one to the environment) and answers what they were
 * and are, both read under the row's lock, so two admins saving at once each see the other's.
 */
export async function changeSiteSettings(
  db: Write,
  change: { [Key in keyof DozoSiteSettings]?: DozoSiteSettings[Key] | undefined },
  byUserId: string,
): Promise<{ before: DozoSiteSettings; after: DozoSiteSettings }> {
  return db.$transaction(async (tx) => {
    await tx.$executeRaw`
      INSERT INTO "dozo_site_settings" ("id") VALUES ('default') ON CONFLICT ("id") DO NOTHING`;
    const rows = await tx.$queryRaw<Row[]>`
      SELECT "signupsOpen", "maxComputersPerUser", "announcementEn", "announcementTr"
      FROM "dozo_site_settings" WHERE "id" = 'default' FOR UPDATE`;
    const before = settingsOf(rows[0]);
    // A setting the change leaves out keeps its value.
    const named = Object.entries(change).filter(([, value]) => value !== undefined);
    const after = settingsOf({ ...before, ...Object.fromEntries(named) });
    await tx.$executeRaw`
      UPDATE "dozo_site_settings" SET
        "signupsOpen" = ${after.signupsOpen},
        "maxComputersPerUser" = ${after.maxComputersPerUser},
        "announcementEn" = ${after.announcementEn},
        "announcementTr" = ${after.announcementTr},
        "updatedByUserId" = ${byUserId},
        "updatedAt" = CURRENT_TIMESTAMP
      WHERE "id" = 'default'`;
    return { before, after };
  });
}

/** Whether new accounts can register: the admin's choice, else `SIGNUPS_ENABLED`. */
export function signupsOpenFrom(settings: DozoSiteSettings, env: string | undefined): boolean {
  return settings.signupsOpen ?? signupsOpen(env);
}

/**
 * The sign-up policy the auth reads where it admits a person: the environment's allowlist, and
 * whether sign-up is open as the admin page or else the environment says.
 */
export async function siteSignupPolicy(
  db: Read,
  env: { signupsEnabled: string | undefined; signupAllowlist: string | undefined },
): Promise<{ enabled: boolean; allowlist: string[] }> {
  const settings = await readSiteSettings(db);
  return { ...signupPolicyFromEnv(env), enabled: signupsOpenFrom(settings, env.signupsEnabled) };
}

/**
 * The per-person computer cap the quota checks read: the admin's, else
 * `SANDBOX_MAX_COMPUTERS_PER_USER`. A client that cannot run SQL (a test double of the computer
 * table) has no admin setting to read.
 */
export async function siteMaxComputersPerUser(db: object): Promise<number> {
  const stored =
    "$queryRaw" in db && typeof db.$queryRaw === "function"
      ? (await readSiteSettings(db as Read)).maxComputersPerUser
      : null;
  return stored ?? resolveMaxComputersPerUser();
}
