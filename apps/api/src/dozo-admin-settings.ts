import { sandboxKindCapabilities } from "@rakazo/adapters";
import type { DozoSiteSettings as DozoSiteSettingsView } from "@rakazo/contracts";
import { abortableDelay, signupsOpen } from "@rakazo/core";
import type { DozoSiteSettings } from "@rakazo/db";
import {
  changeSiteSettings,
  DOZO_SITE_SETTING_KEYS,
  followSiteChanges,
  publishSiteChange,
  readSiteSettings,
  resolveMaxComputersPerUser,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import { requireAdmin } from "./admins.js";
import type { DozoAdminWiring } from "./dozo-admin.js";
import type { RouterDeps } from "./router.js";
import type { RouterContext } from "./routes/context.js";

/**
 * The admin page's site settings and the announcement they carry. Every value is read from the
 * database on each request, so a change holds on every API instance at once. Nothing secret is
 * here: keys, mail passwords and payment keys stay in the environment and never reach this page.
 */
export function dozoSiteSettingsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const { prisma } = deps;
  const admin = authed.use(async ({ context, next }) => {
    await requireAdmin(deps, context.actor.userId);
    return next();
  });
  const wiring = () => (deps as RouterDeps & { dozoAdmin?: DozoAdminWiring }).dozoAdmin;
  const signupsEnv = () => wiring()?.signupsEnabled;

  async function view(settings: DozoSiteSettings): Promise<DozoSiteSettingsView> {
    // The page works without the figure, so a failed read only leaves it out.
    const memory = await bestEffort(
      "read the computers' memory budget for the admin settings",
      sandboxKindCapabilities(deps.sandbox?.describe().id).memory?.(),
    );
    return {
      signupsOpen: settings.signupsOpen,
      maxComputersPerUser: settings.maxComputersPerUser,
      announcementEn: settings.announcementEn ?? "",
      announcementTr: settings.announcementTr ?? "",
      environment: {
        signupsOpen: signupsOpen(signupsEnv()),
        maxComputersPerUser: resolveMaxComputersPerUser(),
      },
      memoryBudgetGb: memory?.totalGb ?? null,
    };
  }

  return {
    dozoSiteSettings: {
      get: admin.dozoSiteSettings.get.handler(async () => view(await readSiteSettings(prisma))),

      /**
       * Each setting that changed is one audit event (who, when, from and to), written in the
       * change's own transaction. Open apps are then told to re-read.
       */
      update: admin.dozoSiteSettings.update.handler(async ({ context, input }) => {
        // An empty announcement is none.
        const line = (value: string | undefined) =>
          value === undefined ? undefined : value || null;
        const change = {
          signupsOpen: input.signupsOpen,
          maxComputersPerUser: input.maxComputersPerUser,
          announcementEn: line(input.announcementEn),
          announcementTr: line(input.announcementTr),
        };
        const { before, after } = await changeSiteSettings(prisma, change, context.actor.userId);
        const changed = DOZO_SITE_SETTING_KEYS.filter((key) => before[key] !== after[key]);
        if (changed.length > 0) publishSiteChange(wiring()?.realtime);
        for (const setting of changed)
          getLogger().info("dozo.admin.site_setting", {
            "admin.id": context.actor.userId,
            setting,
          });
        return view(after);
      }),

      announcement: authed.dozoSiteSettings.announcement.handler(async () => {
        const settings = await readSiteSettings(prisma);
        return { en: settings.announcementEn, tr: settings.announcementTr };
      }),
    },
  };
}

export const DOZO_SITE_CHANGED = Symbol("site settings changed");
const SIGNAL_FAILURE_HOLD_MS = 30_000;

/**
 * The site-settings signals for the app's one live stream: one when it opens, then one per change.
 * Apps re-read the announcement only on these, so a failure ends the stream (after a hold, as the
 * stream's other signals do) and the app reconnects and re-reads.
 */
export async function* dozoSiteChanges(
  deps: RouterDeps,
  signal: AbortSignal,
): AsyncGenerator<typeof DOZO_SITE_CHANGED> {
  const realtime = (deps as RouterDeps & { dozoAdmin?: DozoAdminWiring }).dozoAdmin?.realtime;
  if (!realtime) return;
  try {
    for await (const _ of followSiteChanges(realtime, signal)) yield DOZO_SITE_CHANGED;
  } catch (error) {
    await abortableDelay(SIGNAL_FAILURE_HOLD_MS, signal);
    throw error;
  }
}
