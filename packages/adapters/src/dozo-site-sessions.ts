import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import { ClientError } from "@rakazo/core";
import { hostSite } from "@rakazo/core/egress";
import { browserProfilePathForScreen } from "@rakazo/core/node/desktop-runtime";
import { sandboxKindCapabilities } from "./sandbox-kind-capabilities.js";

/**
 * Sites the bot's browser is signed in to, read and ended inside the bot's computer. The script
 * reads cookie host names and times from a copy of the profile's cookie database, and ends a
 * site's session over the browser's own debugging connection: the running browser when there is
 * one, else a short headless one on the same profile. Cookie values never leave the computer: the
 * script prints host names and times only, and the server keeps nothing it reads.
 * It runs with the computer image's own Python and its CDP client (`page_secrets.py`).
 */
const SCRIPT = String.raw`
import ctypes, json, os, re, shutil, signal, sqlite3, subprocess, sys, tempfile, time
from urllib.parse import urlsplit
sys.path.insert(0, "/usr/local/lib/rakazo")
from page_secrets import CdpClient, discover_ws_url

EPOCH_US = 11644473600 * 1000000
PROFILE = re.compile(r"/home/rakazo/\.browser-profiles/chromium-bot-[a-f0-9]{32}")
BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
            "/opt/google/chrome/chrome", "brave-browser", "/opt/brave.com/brave/brave")


def out(value):
    sys.stdout.write(json.dumps(value))
    sys.exit(0)


def ms(us):
    return max(0, (int(us or 0) - EPOCH_US) // 1000)


def stored_hosts(profile):
    """Each cookie host with its first set and last used time, read from a copy; never a value."""
    for name in ("Default/Network/Cookies", "Default/Cookies"):
        source = os.path.join(profile, name)
        if os.path.isfile(source):
            break
    else:
        return {}
    scratch = tempfile.mkdtemp()
    try:
        for suffix in ("", "-wal", "-journal"):
            if os.path.isfile(source + suffix):
                shutil.copyfile(source + suffix, os.path.join(scratch, "Cookies" + suffix))
        db = sqlite3.connect(os.path.join(scratch, "Cookies"))
        try:
            rows = db.execute(
                "SELECT host_key, MIN(creation_utc), MAX(last_access_utc) FROM cookies GROUP BY host_key"
            ).fetchall()
        finally:
            db.close()
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
    hosts = {}
    for host, created, used in rows:
        known = hosts.setdefault(host.lstrip("."), [ms(created), ms(used)])
        known[0], known[1] = min(known[0], ms(created)), max(known[1], ms(used))
    return hosts


def lock_pid(profile):
    try:
        target = os.readlink(os.path.join(profile, "SingletonLock"))
        pid = int(target.rsplit("-", 1)[1])
        os.kill(pid, 0)
        return pid
    except (OSError, ValueError, IndexError):
        return None


def live_port(profile):
    """The debugging port of the browser running this profile, from its own arguments."""
    if lock_pid(profile) is None:
        return None
    for entry in os.listdir("/proc"):
        if not entry.isdigit():
            continue
        try:
            with open(f"/proc/{entry}/cmdline", "rb") as handle:
                args = handle.read().decode("utf-8", "replace").split("\0")
        except OSError:
            continue
        if f"--user-data-dir={profile}" not in args:
            continue
        for arg in args:
            if arg.startswith("--remote-debugging-port=") and arg[24:].isdigit() and int(arg[24:]):
                try:
                    discover_ws_url(int(arg[24:]))
                    return int(arg[24:])
                except (OSError, ValueError, RuntimeError):
                    pass
    return None


def connect(port):
    client = CdpClient(discover_ws_url(port))
    client.connect()
    return client


def start_headless(profile):
    binary = next((shutil.which(name) for name in BROWSERS if shutil.which(name)), None)
    if not binary:
        raise RuntimeError("no browser")
    marker = os.path.join(profile, "DevToolsActivePort")
    if os.path.exists(marker):
        os.remove(marker)
    process = subprocess.Popen(
        # The visible browser's flags that decide how the profile is read: the same cookie key.
        [binary, "--headless=new", "--test-type", "--no-sandbox", "--disable-dev-shm-usage",
         "--disable-gpu", "--password-store=basic", "--no-first-run", "--no-default-browser-check",
         "--remote-debugging-address=127.0.0.1", "--remote-debugging-port=0",
         f"--user-data-dir={profile}", "about:blank"],
        stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        # Killed with this script, so a timeout never leaves it holding the profile.
        preexec_fn=lambda: ctypes.CDLL("libc.so.6").prctl(1, signal.SIGKILL),
    )
    deadline = time.time() + 15
    while time.time() < deadline:
        if process.poll() is not None:
            raise RuntimeError("browser exited")
        try:
            with open(marker) as handle:
                port = int(handle.readline().strip())
            discover_ws_url(port)
            return process, port
        except (OSError, ValueError, RuntimeError):
            time.sleep(0.2)
    stop_headless(process, None)
    raise RuntimeError("browser did not start")


def stop_headless(process, client):
    if client is not None:
        try:
            client.call("Browser.close", timeout_s=5)
        except Exception:  # noqa: BLE001
            pass
    try:
        process.wait(timeout=5)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


def matching(cookies, hosts):
    return [cookie for cookie in cookies if cookie.get("domain", "").lstrip(".") in hosts]


def sign_out(client, hosts):
    expired = []
    for cookie in matching(client.call("Storage.getCookies").get("cookies", []), hosts):
        param = {key: cookie[key] for key in ("name", "domain", "path", "secure", "httpOnly",
                                               "sameSite", "partitionKey") if key in cookie}
        expired.append({**param, "value": "", "expires": 1})
    for start in range(0, len(expired), 200):
        client.call("Storage.setCookies", {"cookies": expired[start:start + 200]})
    # Site storage is cleared from a tab of its own: the browser target refuses it.
    target = client.call("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        for host in sorted(hosts):
            for scheme in ("https", "http"):
                client.call("Storage.clearDataForOrigin",
                            {"origin": f"{scheme}://{host}", "storageTypes": "all"}, session_id=session)
    finally:
        client.call("Target.closeTarget", {"targetId": target})
    return len(matching(client.call("Storage.getCookies").get("cookies", []), hosts))


def open_site(profile, url):
    if urlsplit(url).scheme not in ("http", "https"):
        out({"ok": False, "error": "url"})
    # The screen may still be starting its browser.
    deadline = time.time() + 15
    port = live_port(profile)
    while port is None and time.time() < deadline:
        time.sleep(0.5)
        port = live_port(profile)
    if port is None:
        out({"ok": False, "error": "no_browser"})
    client = connect(port)
    target = client.call("Target.createTarget", {"url": url})["targetId"]
    client.call("Target.activateTarget", {"targetId": target})
    out({"ok": True})


def main():
    request = json.loads(sys.argv[1])
    profile = request.get("profile", "")
    if not PROFILE.fullmatch(profile):
        out({"ok": False, "error": "profile"})
    if request["op"] == "open":
        open_site(profile, request["url"])
    if not os.path.isdir(profile):
        out({"ok": True, "hosts": []} if request["op"] == "list" else {"ok": True, "remaining": 0})
    if request["op"] == "list":
        hosts = stored_hosts(profile)
        port = live_port(profile)
        if port:
            # A running browser is the truth: it writes to disk about every 30 seconds, so the disk
            # may still hold a site just signed out of and miss one just signed in to. The disk
            # only gives the times; a host it does not know yet has none.
            live = {c.get("domain", "").lstrip(".") for c in connect(port).call("Storage.getCookies").get("cookies", [])}
            hosts = {host: hosts.get(host, [None, None]) for host in live}
        listed = [{"host": h, "created": c, "lastUsed": u} for h, (c, u) in hosts.items() if h]
        out({"ok": True, "hosts": listed[:5000]})
    hosts = set(request["hosts"])
    port = live_port(profile)
    process = None
    if port is None:
        if lock_pid(profile) is not None:
            out({"ok": False, "error": "busy"})
        process, port = start_headless(profile)
    client = None
    try:
        client = connect(port)
        remaining = sign_out(client, hosts)
    finally:
        if process is not None:
            stop_headless(process, client)
    out({"ok": True, "remaining": remaining})


main()
`;

const TIMEOUT_MS = 60_000;

/**
 * A cookie host with its oldest cookie's set time and its last use, in epoch milliseconds; null
 * for a host the running browser has that its disk does not show yet.
 */
export interface CookieHost {
  host: string;
  created: number | null;
  lastUsed: number | null;
}

export interface SiteSession {
  site: string;
  /** Epoch milliseconds; null when no host of the site has a known time yet. */
  since: number | null;
  lastUsedAt: number | null;
  hosts: string[];
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

/** The smaller or larger of two times, either of which may be unknown. */
function either(pick: (...times: number[]) => number, a: number | null, b: number | null) {
  const known = [a, b].filter((time): time is number => time !== null);
  return known.length ? pick(...known) : null;
}

/** Cookie hosts grouped by site, newest use first, then those with no known use. */
export function groupSiteSessions(hosts: CookieHost[]): SiteSession[] {
  const sites = new Map<string, SiteSession>();
  for (const { host, created, lastUsed } of hosts) {
    const site = cookieSite(host);
    if (!site) continue;
    const known = sites.get(site);
    if (!known) {
      sites.set(site, { site, since: created, lastUsedAt: lastUsed, hosts: [host] });
      continue;
    }
    known.hosts.push(host);
    known.since = either(Math.min, known.since, created);
    known.lastUsedAt = either(Math.max, known.lastUsedAt, lastUsed);
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
  const profile = browserProfilePathForScreen(botId);
  let stdout = "";
  let code: number | undefined;
  for await (const event of sandbox.execute(
    computer,
    {
      argv: ["python3", "-I", "-c", SCRIPT, JSON.stringify({ ...request, profile })],
      timeoutMs: TIMEOUT_MS,
    },
    { ...context, botId },
  )) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") code = event.code;
  }
  const parsed: unknown = code === 0 ? JSON.parse(stdout) : undefined;
  if (!parsed || typeof parsed !== "object" || (parsed as { ok?: unknown }).ok !== true) {
    const error = (parsed as { error?: unknown } | undefined)?.error;
    throw new SiteSessionError(
      error === "busy" || error === "no_browser"
        ? "The bot's browser is busy. Try again in a moment."
        : "The bot's computer could not do that.",
    );
  }
  return parsed as Record<string, unknown>;
}

/** The cookie hosts of this bot's browser profile. Never a cookie value. */
export async function readCookieHosts(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  context: AdapterContext,
): Promise<CookieHost[]> {
  const result = await runScript(sandbox, computer, botId, { op: "list" }, context);
  const hosts = Array.isArray(result.hosts) ? result.hosts : [];
  return hosts.flatMap((entry: unknown) => {
    const { host, created, lastUsed } = (entry ?? {}) as Record<string, unknown>;
    const time = (value: unknown) => (typeof value === "number" ? value : null);
    return typeof host === "string" && host
      ? [{ host, created: time(created), lastUsed: time(lastUsed) }]
      : [];
  });
}

/** The sites this bot's browser holds cookies for. */
export async function listSiteSessions(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  context: AdapterContext,
): Promise<SiteSession[]> {
  return groupSiteSessions(await readCookieHosts(sandbox, computer, botId, context));
}

/**
 * Ends the sessions of these sites in this bot's browser: every cookie of their hosts and their
 * hosts' site storage. Hosts are those the browser listed for exactly these sites, never a suffix
 * match, so `example.com` leaves `notexample.com` and `example.com.evil.org` alone.
 */
export async function endSiteSessions(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  botId: string,
  sites: SiteSession[],
  context: AdapterContext,
): Promise<void> {
  const hosts = sites.flatMap(({ site, hosts }) => [...hosts, site, `www.${site}`]);
  if (!hosts.length) return;
  const result = await runScript(
    sandbox,
    computer,
    botId,
    { op: "delete", hosts: [...new Set(hosts)] },
    context,
  );
  if (result.remaining !== 0) throw new SiteSessionError("The bot's computer could not do that.");
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
