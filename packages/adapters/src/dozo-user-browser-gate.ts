import { hostSite } from "@rakazo/core/egress";
import type { PrismaClient } from "@rakazo/db";
import { runAsSystem } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { BROWSER_SIGN_IN_TOOL } from "./dozo-browser-sign-in.tool-definition.js";
import type { DeclaredUserDevice } from "./dozo-device-capabilities.js";
import { deviceOffers } from "./dozo-device-capabilities.js";
import { runCameByToken } from "./dozo-token-run.js";
import type { RunContext } from "./run-context.js";
import { isRunTainted } from "./run-context.js";
import { PAGE_BROWSER_TOOL_NAMES } from "./run-tool-selection.js";
import { USER_COMPUTER_SHELL_TOOL } from "./user-computer-tools.js";

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

/**
 * The user's connected computer this run's page tools go to, if it has a browser: only in a run
 * without a graphical computer of its own (Free has none; a run that has one keeps its own browser,
 * beside its desktop tools), and only while the bot may use the user's computer at all.
 */
export async function userBrowserRoute(ctx: RunContext): Promise<Route | undefined> {
  const owner = ctx.source.userComputerOwner;
  const devices = ctx.deps.userDevices;
  if (!owner || !devices || ctx.computer.graphical) return undefined;
  if (ctx.tools.disabled.has(USER_COMPUTER_SHELL_TOOL)) return undefined;
  const device = (await bestEffort(
    "find the user's computer for its browser",
    devices.connected(owner),
  )) as DeclaredUserDevice | null | undefined;
  return device && deviceOffers(device).browser
    ? { owner, devices, deviceId: device.deviceId }
    : undefined;
}

/** The tools of the bot's own browser on the user's computer: the page tools and the sign-in. */
export function isUserBrowserTool(name: string): boolean {
  return PAGE_BROWSER_TOOL_NAMES.has(name) || name === BROWSER_SIGN_IN_TOOL;
}

/** Whether this call goes to the user's own browser, and so through its approval. */
export async function routesToUserBrowser(ctx: RunContext, name: string): Promise<boolean> {
  return isUserBrowserTool(name) && Boolean(await userBrowserRoute(ctx));
}

/** The site an action on the current page acts on: its registrable domain, or "" when unknown. */
export function pageSite(pageUrl: string | undefined): string {
  if (!pageUrl || !URL.canParse(pageUrl)) return "";
  const url = new URL(pageUrl);
  return /^https?:$/.test(url.protocol) ? (hostSite(url.hostname) ?? "") : "";
}

/**
 * What a call asks the person, kept for its card and its handler: the browser at all, and the
 * site it opens, reads or acts on (by registrable domain; "" for a page whose site is unknown).
 */
export interface UserBrowserAsk {
  /** The computer it asked about, so the call runs there or not at all. */
  deviceId: string;
  browser: boolean;
  site: string;
  /** What the call does there: its consent is for that alone. */
  verb: "open" | "read" | "act" | "signin";
  /** That is not allowed in this thread yet (or the site is unknown), so the card names it. */
  newSite: boolean;
}
const asks = new WeakMap<Record<string, unknown>, UserBrowserAsk>();

export function userBrowserAsk(args: Record<string, unknown>): UserBrowserAsk | undefined {
  return asks.get(args);
}

/** The key under which a call's effect keeps the site its card named (`approvedSite`). */
export const APPROVED_SITE = "approvedSite";

/** What this bot may do with its browser on this computer in this thread. */
async function consents(prisma: PrismaClient, botId: string, deviceId: string, threadId: string) {
  const rows = await runAsSystem(
    "read a bot's browser consents",
    () =>
      prisma.$queryRaw<{ site: string }[]>`
      SELECT site FROM dozo_browser_consents
      WHERE "botId" = ${botId} AND "deviceId" = ${deviceId} AND "threadId" = ${threadId}`,
  );
  return new Set(rows.map((row) => row.site));
}

export async function recordConsent(
  prisma: PrismaClient,
  key: { botId: string; deviceId: string; threadId: string },
  site: string,
) {
  await runAsSystem(
    "record a bot's browser consent",
    () =>
      prisma.$executeRaw`
      INSERT INTO dozo_browser_consents ("botId", "deviceId", "threadId", site)
      VALUES (${key.botId}, ${key.deviceId}, ${key.threadId}, ${site})
      ON CONFLICT DO NOTHING`,
  );
}

/** What a call does on its site, as its consent and its card name it. */
export function browserVerb(name: string): "open" | "read" | "act" | "signin" {
  if (name === "browser_navigate") return "open";
  if (name === "browser_snapshot") return "read";
  if (name === BROWSER_SIGN_IN_TOOL) return "signin";
  return "act";
}

/**
 * The approval of a tool of the user's own browser, in every approval mode. A block or a run a
 * token's message reached refuses it. Each thread asks again: the bot's first use of the browser
 * there, and the first time it opens, reads, acts on or signs in to each site, each of those on its
 * own, so allowing a look at a site allows no action there. Once content from outside has entered
 * the run (a page it read, a fetched text), opening another site than the one the browser shows
 * asks every time: a page that steers the bot cannot send it, or what it read, elsewhere unseen.
 * The site comes from the address it opens, or from the browser itself for what it shows (the
 * person may have moved it); a page whose site cannot be told is asked about, a blank one is not.
 * The card's site is kept with the call (`APPROVED_SITE`), so a resumed call runs only on it.
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
  const allowed = await consents(ctx.deps.prisma, ctx.bot.id, route.deviceId, ctx.thread.id);
  const browser = !allowed.has("");
  const verb = browserVerb(name);
  // Before the browser is allowed it is not started, so what it shows is a blank page.
  const shown = browser ? "about:blank" : await currentUrl(ctx, route);
  const named = verb === "open" || verb === "signin";
  const site = named
    ? pageSite(verb === "open" ? String(args.url ?? "") : `https://${String(args.site ?? "")}/`)
    : pageSite(shown);
  const blank = shown === "about:blank";
  let newSite = site ? !allowed.has(`${verb}:${site}`) : !(verb === "read" && blank);
  if (verb === "open" && !newSite && site !== pageSite(shown) && (await isRunTainted(ctx)))
    newSite = true;
  const ask: UserBrowserAsk = { deviceId: route.deviceId, browser, site, verb, newSite };
  asks.set(args, ask);
  args[APPROVED_SITE] = site;
  return browser || newSite ? "ask" : "allow";
}

/** The address the bot's browser shows, or undefined when it cannot tell. */
async function currentUrl(ctx: RunContext, route: Route): Promise<string | undefined> {
  const request = route.devices.request<{ result?: { currentIndex?: number; entries?: unknown } }>(
    route.owner,
    {
      method: "pageBrowser",
      botId: ctx.bot.id,
      runId: ctx.runId,
      command: { method: "Page.getNavigationHistory" },
    },
    ctx.context.signal,
    route.deviceId,
  );
  let answer: { result?: { currentIndex?: number; entries?: unknown } } | undefined;
  try {
    for await (const value of request) answer = value;
  } catch {
    // A browser that cannot answer leaves the site unknown, which asks.
    return undefined;
  }
  const entries = Array.isArray(answer?.result?.entries) ? answer.result.entries : [];
  const entry = entries[Number(answer?.result?.currentIndex)] as { url?: unknown } | undefined;
  return typeof entry?.url === "string" ? entry.url : undefined;
}
