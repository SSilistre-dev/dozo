import { sandboxKindCapabilities } from "@rakazo/adapters";
import type { DozoSiteSettings as DozoSiteSettingsView } from "@rakazo/contracts";
import { signupsOpen } from "@rakazo/core";
import type { DozoSiteSettings } from "@rakazo/db";
import {
  changeSiteSettings,
  DOZO_SITE_SETTING_KEYS,
  readSiteSettings,
  recordSecurityEvent,
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
  const signupsEnv = () =>
    (deps as RouterDeps & { dozoAdmin?: DozoAdminWiring }).dozoAdmin?.signupsEnabled;

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

      /** Each setting that changed is one audit event: who, when, from and to. */
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
        for (const key of DOZO_SITE_SETTING_KEYS) {
          if (before[key] === after[key]) continue;
          await recordSecurityEvent({
            type: "deployment.settings.changed",
            userId: context.actor.userId,
            metadata: { setting: key, from: before[key], to: after[key] },
          });
          getLogger().info("dozo.admin.site_setting", {
            "admin.id": context.actor.userId,
            setting: key,
          });
        }
        return view(after);
      }),

      announcement: authed.dozoSiteSettings.announcement.handler(async () => {
        const settings = await readSiteSettings(prisma);
        return { en: settings.announcementEn, tr: settings.announcementTr };
      }),
    },
  };
}
