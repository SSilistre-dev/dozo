/**
 * The script `dozo-site-sessions.ts` runs inside a bot's computer, with the computer image's own
 * Python and its CDP client (`page_secrets.py`). It reads a JSON request from its one argument
 * and prints one JSON reply. Cookie values never leave it: it prints host names, times and
 * storage keys only. Its behaviour against a real browser is tested by
 * `dozo/e2e/site-sessions-image.sh`, which runs this text in the computer image.
 *
 * - `list`: cookie hosts with times (the running browser decides which, the disk gives the times),
 *   the hosts of pages opened at the top level (since `since`, from the browser's history and its
 *   open tabs) and every storage key, partitioned ones included.
 * - `delete`: removes the cookies of exactly `hosts` (partitioned ones too) and everything stored
 *   under `storageKeys` and the hosts' origins, then reads back what is left without opening any
 *   page (so nothing lands in the history or recreates storage): cookies and service workers
 *   through the browser, storage buckets and Local Storage keys from the profile. Replies how
 *   much is left, or null when it could not tell in time.
 * - `open`: opens an http(s) address in a new tab of the running browser.
 */
export const SITE_SESSIONS_SCRIPT = String.raw`
import ctypes, json, os, re, shutil, signal, sqlite3, subprocess, sys, tempfile, time
from urllib.parse import urlsplit
sys.path.insert(0, "/usr/local/lib/rakazo")
from page_secrets import CdpClient, discover_ws_url

EPOCH_US = 11644473600 * 1000000
PROFILE = re.compile(r"/home/rakazo/\.browser-profiles/chromium-bot-[a-f0-9]{32}")
BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
            "/opt/google/chrome/chrome", "brave-browser", "/opt/brave.com/brave/brave")
LIMIT = 5000
START = time.time()
# The API gives the whole command 60 seconds; the rest is for the reply.
BUDGET = 50


def out(value):
    sys.stdout.write(json.dumps(value))
    sys.exit(0)


def left():
    return BUDGET - (time.time() - START)


def ms(us):
    return max(0, (int(us) - EPOCH_US) // 1000) if us else None


def pick(choose, a, b):
    known = [t for t in (a, b) if t is not None]
    return choose(known) if known else None


def rows(path, sql, args=()):
    """Rows from a copy of a database the browser may hold open; none when it is missing or odd."""
    if not os.path.isfile(path):
        return []
    scratch = tempfile.mkdtemp()
    try:
        for suffix in ("", "-wal", "-journal"):
            if os.path.isfile(path + suffix):
                shutil.copyfile(path + suffix, os.path.join(scratch, "db" + suffix))
        db = sqlite3.connect(os.path.join(scratch, "db"))
        try:
            return db.execute(sql, args).fetchmany(LIMIT)
        finally:
            db.close()
    except sqlite3.Error:
        return []
    finally:
        shutil.rmtree(scratch, ignore_errors=True)


def stored_hosts(profile):
    """Each cookie host with its first set and last used time; never a value."""
    path = os.path.join(profile, "Default/Network/Cookies")
    if not os.path.isfile(path):
        path = os.path.join(profile, "Default/Cookies")
    hosts = {}
    for host, created, used in rows(path, "SELECT host_key, MIN(creation_utc), MAX(last_access_utc) "
                                          "FROM cookies GROUP BY host_key"):
        known = hosts.setdefault(host.lstrip("."), [None, None])
        known[0] = pick(min, known[0], ms(created))
        known[1] = pick(max, known[1], ms(used))
    return hosts


def storage_keys(profile):
    """Every storage key the profile holds data under, partitioned ones included."""
    keys = quota_keys(profile) | {key for key, alive in meta_keys(profile).items() if alive}
    return sorted(key for key in keys if valid_key(key))[:LIMIT]


def quota_keys(profile):
    return {key for (key,) in rows(os.path.join(profile, "Default/WebStorage/QuotaManager"),
                                   "SELECT storage_key FROM buckets")}


def meta_keys(profile):
    """Local Storage's "META:<storage key>" keys and whether each is still there: the last write
    wins, tables (.ldb, older) before the log. In a log record a write is tag 1 and a removal tag 0,
    then the key's length; in a table the entry's unshared length counts an 8-byte trailer whose
    first byte is the same tag."""
    state = {}
    folder = os.path.join(profile, "Default/Local Storage/leveldb")
    names = sorted(os.listdir(folder)) if os.path.isdir(folder) else []
    for name in [n for n in names if n.endswith(".ldb")] + [n for n in names if n.endswith(".log")]:
        with open(os.path.join(folder, name), "rb") as handle:
            data = handle.read()
        for match in re.finditer(rb"META:", data):
            at = match.start()
            if name.endswith(".log") and at >= 2 and data[at - 2] in (0, 1) and data[at - 1] < 128:
                size, alive = data[at - 1], data[at - 2] == 1
            elif name.endswith(".ldb") and at >= 3 and data[at - 3] == 0 and 13 < data[at - 2] < 128:
                size = data[at - 2] - 8
                alive = data[at + size] == 1 if at + size < len(data) else True
            else:
                continue
            key = data[at + 5:at + size]
            if key.isascii():
                text = key.decode("ascii")
                state[text if "/" in text[8:] else text + "/"] = alive
    return state


def host_of(url):
    parts = urlsplit(url)
    return parts.hostname if parts.scheme in ("http", "https") else None


def visited(profile, since_ms):
    """Hosts of the pages opened at the top level since then, from the browser's history."""
    since = since_ms * 1000 + EPOCH_US if since_ms else 0
    # Newest first, so a long history never cuts off the sites just signed in to.
    found = rows(os.path.join(profile, "Default/History"),
                 "SELECT urls.url, MAX(visits.visit_time) AS last FROM visits JOIN urls ON urls.id = visits.url "
                 "WHERE (visits.transition & 255) NOT IN (3, 4) AND visits.visit_time >= ? "
                 "GROUP BY urls.id ORDER BY last DESC", (since,))
    return {host_of(url) for (url, _) in found} - {None}


def lock_pid(profile):
    try:
        pid = int(os.readlink(os.path.join(profile, "SingletonLock")).rsplit("-", 1)[1])
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
                # Chromium rewrites its title into one space-joined line; a profile path has no space.
                args = re.split(r"[\0 ]", handle.read().decode("utf-8", "replace"))
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
    deadline = time.time() + min(15, left())
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


def matching(client, hosts):
    cookies = client.call("Storage.getCookies").get("cookies", [])
    return [c for c in cookies if c.get("domain", "").lstrip(".") in hosts]


IPV4 = re.compile(r"(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])(\.(25[0-5]|2[0-4][0-9]|1?[0-9]?[0-9])){3}")
NAME = re.compile(r"[a-z0-9_]([a-z0-9_-]{0,62})(\.[a-z0-9_]([a-z0-9_-]{0,62}))*")


def valid_host(host):
    """A host the browser reads as itself: a dotted IPv4 address, or a name whose last label is
    not a number (the URL standard reads "www.10.0.0.5" as a broken address)."""
    if IPV4.fullmatch(host):
        return True
    return bool(NAME.fullmatch(host)) and not host.rsplit(".", 1)[-1].isdigit()


KEY = re.compile(r"(https?://[^/^]+)/(\^0(https?://[^/^]+))?")


def valid_key(key):
    """A storage key in the browser's own form whose origin, and top-level site if any, are hosts
    the browser reads as themselves."""
    match = KEY.fullmatch(key)
    return bool(match) and all(valid_host(urlsplit(part).hostname or "")
                               for part in (match.group(1), match.group(3)) if part)


def first_party(key):
    """The origin a storage key belongs to, and the top-level site it is partitioned under."""
    origin, _, top = key.partition("^0")
    return origin.rstrip("/"), (top or None)


def service_worker_scopes(client, session):
    """The scopes of every service worker registration, read without opening any page."""
    seen = []
    handle = client._handle_event

    def keep(message):
        if message.get("method") == "ServiceWorker.workerRegistrationUpdated":
            seen.extend(r.get("scopeURL", "") for r in message.get("params", {}).get("registrations", [])
                         if not r.get("isDeleted"))
        else:
            handle(message)
    client._handle_event = keep
    try:
        client.call("ServiceWorker.enable", session_id=session)
        # The registrations arrive as events right after; a short read collects them.
        client.call("Runtime.evaluate", {"expression": "1"}, session_id=session)
        client.call("ServiceWorker.disable", session_id=session)
    finally:
        client._handle_event = handle
    return seen


def sign_out(client, profile, hosts, keys):
    """Ends the site everywhere the browser keeps it, then reads back, without opening any page,
    how much is left: cookies, storage buckets, Local Storage keys and service workers. None
    when it could not tell in time."""
    expired = []
    for cookie in matching(client, hosts):
        param = {key: cookie[key] for key in ("name", "domain", "path", "secure", "httpOnly",
                                               "sameSite", "partitionKey") if key in cookie}
        expired.append({**param, "value": "", "expires": 1})
    for start in range(0, len(expired), 200):
        client.call("Storage.setCookies", {"cookies": expired[start:start + 200]})
    keys = [key for key in keys if valid_key(key)]
    # An address the browser cannot parse reads as an opaque origin, and clearing one clears
    # everything: only well-formed hosts are ever sent.
    origins = {f"{scheme}://{host}" for host in hosts if valid_host(host) for scheme in ("https", "http")}
    origins |= {first_party(key)[0] for key in keys}
    # Site storage is cleared from a tab of its own: the browser target refuses it.
    target = client.call("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        for key in keys:
            client.call("Storage.clearDataForStorageKey", {"storageKey": key, "storageTypes": "all"},
                        session_id=session)
        for origin in sorted(origins):
            client.call("Storage.clearDataForOrigin", {"origin": origin, "storageTypes": "all"},
                        session_id=session)
        workers = [scope for scope in service_worker_scopes(client, session)
                   if urlsplit(scope).scheme + "://" + (urlsplit(scope).netloc or "") in origins]
    finally:
        client.call("Target.closeTarget", {"targetId": target})
    mine = set(keys)
    ours = lambda key: key in mine or first_party(key)[0] in origins
    # The browser writes the removals to disk within moments: wait a little for them, then count.
    settle = time.time() + min(3, max(0, left() - 2))
    while True:
        stored = [key for key in quota_keys(profile) if ours(key)]
        stored += [key for key, alive in meta_keys(profile).items() if alive and ours(key)]
        if not stored or time.time() >= settle:
            break
        time.sleep(0.3)
    return len(matching(client, hosts)) + len(stored) + len(workers)


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
        out({"ok": True, "hosts": [], "visited": [], "storageKeys": []} if request["op"] == "list"
            else {"ok": True, "remaining": 0})
    if request["op"] == "list":
        hosts = stored_hosts(profile)
        seen = visited(profile, request.get("since"))
        port = live_port(profile)
        if port:
            client = connect(port)
            # A running browser is the truth: it writes to disk about every 30 seconds, so the disk
            # may still hold a site just signed out of and miss one just signed in to. The disk
            # only gives the times; a host it does not know yet has none.
            live = {c.get("domain", "").lstrip(".") for c in client.call("Storage.getCookies").get("cookies", [])}
            hosts = {host: hosts.get(host, [None, None]) for host in live}
            # Open tabs are top-level visits the history may not have saved yet.
            tabs = client.call("Target.getTargets").get("targetInfos", [])
            seen |= {host_of(t.get("url", "")) for t in tabs if t.get("type") == "page"} - {None}
        out({"ok": True,
             "hosts": [{"host": h, "created": c, "lastUsed": u} for h, (c, u) in hosts.items() if h][:LIMIT],
             "visited": sorted(seen)[:LIMIT], "storageKeys": storage_keys(profile)})
    hosts = set(request["hosts"])
    keys = list(request["storageKeys"])
    port = live_port(profile)
    process = None
    if port is None:
        if lock_pid(profile) is not None:
            out({"ok": False, "error": "busy"})
        process, port = start_headless(profile)
    client = None
    try:
        client = connect(port)
        remaining = sign_out(client, profile, hosts, keys)
    finally:
        if process is not None:
            stop_headless(process, client)
    out({"ok": True, "remaining": remaining})


main()
`;
