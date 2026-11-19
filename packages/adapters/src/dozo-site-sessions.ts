import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { SITE_SESSIONS_SCRIPT } from "./dozo-site-sessions.script.js";
import { sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";

/**
 * Sites the bot's browser holds cookies for, read and ended inside the bot's computer by
 * `SITE_SESSIONS_SCRIPT`. Only host names, times and storage keys come back, never a value, and
 * the server keeps nothing it reads.
 */
const TIMEOUT_MS = 60_000;
/** A reply longer than the script's own limits can make is not read. */
const MAX_REPLY_BYTES = 4 * 1024 * 1024;
/** The request is one argument: well under Linux's 128 KiB limit for a single one. */
const MAX_REQUEST_BYTES = 100_000;
const FAILED = "The bot's computer could not do that.";

/**
 * A cookie host with its oldest cookie's set time and its last use, in epoch milliseconds; null
 * for a host the running browser has that its disk does not show yet.
 */
export interface CookieHost {
  host: string;
  created: number | null;
  lastUsed: number | null;
}

/** What the script read from the bot's browser profile. */
export interface BrowserSites {
  hosts: CookieHost[];
  /** Hosts of pages opened at the top level (since the time asked for, or ever). */
  visited: string[];
  /** Every key the profile stores data under, partitioned ones (`origin/^0top`) included. */
  storageKeys: string[];
}

export interface SiteSession {
  site: string;
  /** Epoch milliseconds; null when no host of the site has a known time yet. */
  since: number | null;
  lastUsedAt: number | null;
  hosts: string[];
  storageKeys: string[];
}

/** Refused by the bot's computer: it is busy or could not act. */
export class SiteSessionError extends ClientError {
  constructor(message: string) {
    super("CONFLICT", message);
    this.name = "SiteSessionError";
  }
}

/** Whether this computer's provider declares it can read and end its browser's site sessions. */
export function hasSiteSessions(kind: string | null | undefined): boolean {
  return sandboxKindCapabilities(kind).siteSessions === true;
}

/**
 * The site a cookie host belongs to: its registrable domain, private suffixes included, so
 * `alice.github.io` and `bob.github.io` are two sites.
 */
export function cookieSite(host: string): string | undefined {
  return hostSite(host.replace(/^\./, ""));
}

/** The site of the origin a storage key belongs to, whatever site it is partitioned under. */
export function storageKeySite(key: string): string | undefined {
  const origin = key.split("^")[0]!;
  return URL.canParse(origin) ? cookieSite(new URL(origin).hostname) : undefined;
}

/** The smaller or larger of two times, either of which may be unknown. */
function either(pick: (...times: number[]) => number, a: number | null, b: number | null) {
  const known = [a, b].filter((time): time is number => time !== null);
  return known.length ? pick(...known) : null;
}

/**
 * Cookie hosts grouped by site, newest use first, then those with no known use. A site counts
 * only when a page of it was opened at the top level: a tracker or a CDN that only ever loaded
 * inside other sites' pages has cookies, but no one signed in to it.
 */
export function groupSiteSessions(browser: BrowserSites): SiteSession[] {
  const visited = new Set(browser.visited.map(cookieSite));
  const sites = new Map<string, SiteSession>();
  for (const { host, created, lastUsed } of browser.hosts) {
    const site = cookieSite(host);
    if (!site || !visited.has(site)) continue;
    const known = sites.get(site);
    if (!known) {
      sites.set(site, {
        site,
        since: created,
        lastUsedAt: lastUsed,
        hosts: [host],
        storageKeys: [],
      });
      continue;
    }
    known.hosts.push(host);
    known.since = either(Math.min, known.since, created);
    known.lastUsedAt = either(Math.max, known.lastUsedAt, lastUsed);
  }
  for (const key of browser.storageKeys) {
    const site = storageKeySite(key);
    if (site) sites.get(site)?.storageKeys.push(key);
  }
  return [...sites.values()].sort((a, b) => (b.lastUsedAt ?? -1) - (a.lastUsedAt ?? -1));
}

async function runScript(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  request: Record<string, unknown>,
  context: AdapterContext,
): Promise<Record<string, unknown>> {
  const argument = JSON.stringify({ ...request, profile: browserProfilePathForScreen(botId) });
  if (argument.length > MAX_REQUEST_BYTES) throw new SiteSessionError(FAILED);
  let stdout = "";
  let code: number | undefined;
  for await (const event of sandbox.execute(
    computer,
    { argv: ["python3", "-I", "-c", SITE_SESSIONS_SCRIPT, argument], timeoutMs: TIMEOUT_MS },
    { ...context, botId },
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") code = event.code;
    if (stdout.length > MAX_REPLY_BYTES) throw new SiteSessionError(FAILED);
  }
  let parsed: unknown;
  try {
    parsed = code === 0 ? JSON.parse(stdout) : undefined;
  } catch {
    // A reply cut short or garbled by the computer says nothing about what happened.
    throw new SiteSessionError(FAILED);
  }
  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
    const error = (parsed as { error?: unknown } | undefined)?.error;
    throw new SiteSessionError(
      error === "busy" || error === "no_browser"
        ? "The bot's browser is busy. Try again in a moment."
        : FAILED,
    );
  }
  return parsed as Record<string, unknown>;
}

const strings = (value: unknown) =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** What this bot's browser profile holds, by name: cookie hosts, visits since `since`, keys. */
export async function readBrowserSites(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  context: AdapterContext,
  since?: number,
): Promise<BrowserSites> {
  const result = await runScript(
    sandbox,
    computer,
    botId,
    { op: "list", ...(since === undefined ? {} : { since }) },
    context,
  );
  const time = (value: unknown) => (typeof value === "number" ? value : null);
  const hosts = (Array.isArray(result.hosts) ? result.hosts : []).flatMap((entry: unknown) => {
    const { host, created, lastUsed } = (entry ?? {}) as Record<string, unknown>;
    return typeof host === "string" && host
      ? [{ host, created: time(created), lastUsed: time(lastUsed) }]
      : [];
  });
  return { hosts, visited: strings(result.visited), storageKeys: strings(result.storageKeys) };
}

/** The sites this bot's browser holds cookies for and that were opened at the top level. */
export async function listSiteSessions(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  context: AdapterContext,
): Promise<SiteSession[]> {
  return groupSiteSessions(await readBrowserSites(sandbox, computer, botId, context));
}

/** The hosts a site is ended on: those the browser listed, plus its bare and www names. */
function hostsOf({ site, hosts }: SiteSession): string[] {
  // An address has no www name, and "www.10.0.0.5" is not an address the browser can read.
  const named = /[a-z]/i.test(site.split(".").at(-1) ?? "") && !site.startsWith("[");
  return [...new Set([...hosts, site, ...(named ? [`www.${site}`] : [])])];
}

/**
 * Ends these sites in this bot's browser: every cookie of their hosts (partitioned ones too) and
 * everything stored under their storage keys and origins. Hosts are those the browser listed for
 * exactly these sites, never a suffix match, so `example.com` leaves `notexample.com` and
 * `example.com.evil.org` alone. Fails unless the script found nothing left afterwards.
 */
export async function endSiteSessions(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  sites: SiteSession[],
  context: AdapterContext,
): Promise<void> {
  // Sites go in as few requests as fit one argument each.
  const batches: SiteSession[][] = [];
  for (const site of sites) {
    const last = batches.at(-1);
    if (last && requestSize([...last, site]) <= MAX_REQUEST_BYTES) last.push(site);
    else batches.push([site]);
  }
  for (const batch of batches) {
    const result = await runScript(sandbox, computer, botId, deleteRequest(batch), context);
    if (result.remaining !== 0) throw new SiteSessionError(FAILED);
  }
}

function deleteRequest(sites: SiteSession[]) {
  return {
    op: "delete",
    hosts: sites.flatMap(hostsOf),
    storageKeys: sites.flatMap(({ storageKeys }) => storageKeys),
  };
}

function requestSize(sites: SiteSession[]) {
  // The profile path the request also carries is well under this margin.
  return JSON.stringify(deleteRequest(sites)).length + 200;
}

/** Opens an http(s) address in a new tab of this bot's running browser. */
export async function openSiteInBrowser(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  url: string,
  context: AdapterContext,
): Promise<void> {
  await runScript(sandbox, computer, botId, { op: "open", url }, context);
}
