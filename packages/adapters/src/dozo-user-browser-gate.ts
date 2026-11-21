import { hostSite } from "@rakazo/core/egress";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import type { DeclaredUserDevice } from "./dozo-device-capabilities.js";
import { deviceOffers } from "./dozo-device-capabilities.js";
import { runCameByToken } from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";

/**
 * Where the page tools go and what they ask, for the bot's own browser on the user's computer
 * (dozo-user-browser.ts runs them). Consents are kept per bot and computer: the browser at all
 * (site "") and each site acted on, by registrable domain.
 */
export type Route = {
  owner: string;
  deviceId: string;
  devices: NonNullable<RunContext["deps"]["userDevices"]>;
};

/** The user's connected computer this run's page tools go to, if it has a browser. */
export async function userBrowserRoute(ctx: RunContext): Promise<Route | undefined> {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  if (!owner || !devices) return undefined;
  const device = (await devices.connected(owner).catch(() => null)) as DeclaredUserDevice | null;
  return device && deviceOffers(device).browser
    ? { owner, devices, deviceId: device.deviceId }
    : undefined;
}

/** Whether this call goes to the user's own browser, and so through its approval. */
export async function routesToUserBrowser(ctx: RunContext, name: string): Promise<boolean> {
  return PAGE_BROWSER_TOOL_NAMES.has(name) && Boolean(await userBrowserRoute(ctx));
}

/** The site an action on the current page acts on: its registrable domain, or "" when unknown. */
export function pageSite(pageUrl: string | undefined): string {
  if (!pageUrl || !URL.canParse(pageUrl)) return "";
  const url = new URL(pageUrl);
  return /^https?:$/.test(url.protocol) ? (hostSite(url.hostname) ?? "") : "";
}

/** What a call asks the person, kept for its card: the browser at all, and the site it acts on. */
export interface UserBrowserAsk {
  browser: boolean;
  /** Set for an action: the site, or "" for a page whose site is unknown. */
  site?: string;
}
const asks = new WeakMap<Record<string, unknown>, UserBrowserAsk>();

export function userBrowserAsk(args: Record<string, unknown>): UserBrowserAsk | undefined {
  return asks.get(args);
}

async function consents(prisma: PrismaClient, botId: string, deviceId: string) {
  const rows = await runAsSystem(
    "read a bot's browser consents",
    () =>
      prisma.$queryRaw<{ site: string }[]>`
      SELECT site FROM dozo_browser_consents WHERE "botId" = ${botId} AND "deviceId" = ${deviceId}`,
  );
  return new Set(rows.map((row) => row.site));
}

export async function recordConsent(
  prisma: PrismaClient,
  botId: string,
  deviceId: string,
  site: string,
) {
  await runAsSystem(
    "record a bot's browser consent",
    () =>
      prisma.$executeRaw`
      INSERT INTO dozo_browser_consents ("botId", "deviceId", site)
      VALUES (${botId}, ${deviceId}, ${site})
      ON CONFLICT DO NOTHING`,
  );
}

/**
 * The approval of a page tool on the user's own browser, in every approval mode: a block or a run a
 * token's message reached refuses it; the bot's first use of the browser on this computer asks,
 * and so does an action on a site it has not acted on there before. Looking (navigate, snapshot)
 * goes ahead once the browser is allowed.
 */
export async function userBrowserGate(
  ctx: RunContext,
  blocked: boolean,
  name: string,
  args: Record<string, unknown>,
): Promise<"deny" | "allow" | "ask"> {
  if (blocked || (await runCameByToken(ctx))) return "deny";
  const route = await userBrowserRoute(ctx);
  if (!route) return "ask";
  const allowed = await consents(ctx.deps.prisma, ctx.bot.id, route.deviceId);
  const ask: UserBrowserAsk = { browser: !allowed.has("") };
  if (name === "browser_act") {
    const site = pageSite(ctx.state.pageUrl);
    if (!site || !allowed.has(site)) ask.site = site;
  }
  if (!ask.browser && ask.site === undefined) return "allow";
  asks.set(args, ask);
  return "ask";
}
