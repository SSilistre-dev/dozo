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
 *   under `storageKeys` and the hosts' origins, then checks: cookies through the browser, storage
 *   by opening each key's origin in a page the script answers itself, with no network. Replies
 *   how much is left, or null when it could not tell in time.
 * - `open`: opens an http(s) address in a new tab of the running browser.
 */
export const SITE_SESSIONS_SCRIPT = String.raw`
import base64, ctypes, json, os, re, shutil, signal, sqlite3, subprocess, sys, tempfile, time
from urllib.parse import urlsplit
sys.path.insert(0, "/usr/local/lib/rakazo")
from page_secrets import CdpClient, discover_ws_url

EPOCH_US = 11644473600 * 1000000
PROFILE = re.compile(r"/home/rakazo/\.browser-profiles/chromium-bot-[a-f0-9]{32}")
BROWSERS = ("chromium", "chromium-browser", "google-chrome", "google-chrome-stable",
            "/opt/google/chrome/chrome", "brave-browser", "/opt/brave.com/brave/brave")
# The page a check opens to read what an origin still stores: never fetched, never a visit.
CHECK_PATH = "/.dozo-site-check"
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
    keys = {key for (key,) in rows(os.path.join(profile, "Default/WebStorage/QuotaManager"),
                                   "SELECT storage_key FROM buckets")}
    folder = os.path.join(profile, "Default/Local Storage/leveldb")
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if name.endswith((".log", ".ldb")):
            with open(os.path.join(folder, name), "rb") as handle:
                keys |= meta_keys(handle.read())
    # Local Storage writes a first-party key without the slash the browser's own form has.
    keys = {key if "/" in key[8:] else key + "/" for key in keys}
    return sorted(key for key in keys if VALID_KEY.fullmatch(key))[:LIMIT]


VALID_KEY = re.compile(r"https?://[A-Za-z0-9.\-\[\]:]+/(\^[0-9][!-~]+)?")


def meta_keys(data):
    """Local Storage's "META:<storage key>" keys, each read to its stored length: in a log record
    a put is tag 1 then the key's length, in a table the entry's unshared length counts 8 more."""
    found = set()
    for match in re.finditer(rb"META:", data):
        at = match.start()
        if at >= 2 and data[at - 2] == 1 and data[at - 1] < 128:
            size = data[at - 1]
        elif at >= 3 and data[at - 3] == 0 and 8 < data[at - 2] < 128:
            size = data[at - 2] - 8
        else:
            continue
        key = data[at + 5:at + size]
        if key.isascii():
            found.add(key.decode("ascii"))
    return found


def host_of(url):
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or parts.path == CHECK_PATH:
        return None
    return parts.hostname


def visited(profile, since_ms):
    """Hosts of the pages opened at the top level since then, from the browser's history."""
    since = since_ms * 1000 + EPOCH_US if since_ms else 0
    found = rows(os.path.join(profile, "Default/History"),
                 "SELECT DISTINCT urls.url FROM visits JOIN urls ON urls.id = visits.url "
                 "WHERE (visits.transition & 255) NOT IN (3, 4) AND visits.visit_time >= ?", (since,))
    return {host_of(url) for (url,) in found} - {None}


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


def first_party(key):
    """The origin a storage key belongs to, and the top-level site it is partitioned under."""
    origin, _, top = key.partition("^0")
    return origin.rstrip("/"), (top or None)


PROBE = ("(async () => { const r = { ls: localStorage.length };"
         " try { r.idb = (await indexedDB.databases()).length } catch (e) { r.idb = 0 }"
         " try { r.caches = (await caches.keys()).length } catch (e) { r.caches = 0 }"
         " try { r.sw = (await navigator.serviceWorker.getRegistrations()).length } catch (e) { r.sw = 0 }"
         " (window.parent === window ? window : window.parent).postMessage({ dozo: r }, '*'); })();")
LISTEN = "addEventListener('message', (e) => { if (e.data && e.data.dozo) window.__dozo = e.data.dozo });"
WAIT = "new Promise((r) => { const t = () => window.__dozo ? r(window.__dozo) : setTimeout(t, 100); t(); })"


def paused_requests(client):
    """Fetch.requestPaused events, kept even when they arrive while another call waits."""
    queue = getattr(client, "dozo_paused", None)
    if queue is None:
        queue = client.dozo_paused = []
        handle = client._handle_event

        def keep(message):
            if message.get("method") == "Fetch.requestPaused":
                queue.append(message)
            else:
                handle(message)
        client._handle_event = keep
    return queue


def probe(client, origin, top):
    """What an origin still stores, read from a page this script answers itself: no network."""
    queue = paused_requests(client)
    target = client.call("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        client.call("Fetch.enable", {"patterns": [{"urlPattern": "*"}]}, session_id=session)
        pages = {origin + CHECK_PATH: f"<script>{PROBE}</script>"}
        url = (top or origin) + CHECK_PATH
        pages[url] = (f"<script>{LISTEN}</script><iframe src='{origin}{CHECK_PATH}'></iframe>" if top
                      else f"<script>{LISTEN}{PROBE}</script>")
        client._send(0x1, json.dumps({"id": 900000, "method": "Page.navigate", "params": {"url": url},
                                      "sessionId": session}).encode())
        served, deadline = 0, time.time() + max(1, min(5, left()))
        while served < len(pages) and time.time() < deadline:
            if not queue:
                client._sock.settimeout(0.5)
                try:
                    message = json.loads(client._read_frame().decode("utf-8"))
                except (OSError, ValueError):
                    continue
                if message.get("method") == "Fetch.requestPaused":
                    queue.append(message)
                continue
            message = queue.pop(0)
            params = message["params"]
            body = pages.get(params["request"]["url"].split("?")[0], "")
            served += 1 if body else 0
            client.call("Fetch.fulfillRequest", {
                "requestId": params["requestId"], "responseCode": 200,
                "responseHeaders": [{"name": "Content-Type", "value": "text/html"}],
                "body": base64.b64encode(body.encode()).decode()}, session_id=message.get("sessionId"))
        result = client.call("Runtime.evaluate", {"expression": WAIT, "awaitPromise": True, "returnByValue": True},
                             session_id=session, timeout_s=max(1, min(5, left())))
        counts = result.get("result", {}).get("value")
        return sum(counts.values()) if isinstance(counts, dict) else None
    except (OSError, RuntimeError):
        return None
    finally:
        queue.clear()
        client.call("Target.closeTarget", {"targetId": target})


def sign_out(client, hosts, keys):
    """Ends the site everywhere the browser keeps it; how much is left, or None when unknown."""
    expired = []
    for cookie in matching(client, hosts):
        param = {key: cookie[key] for key in ("name", "domain", "path", "secure", "httpOnly",
                                               "sameSite", "partitionKey") if key in cookie}
        expired.append({**param, "value": "", "expires": 1})
    for start in range(0, len(expired), 200):
        client.call("Storage.setCookies", {"cookies": expired[start:start + 200]})
    # An address the browser cannot parse reads as an opaque origin, and clearing one clears
    # everything: only well-formed hosts are ever sent.
    origins = {f"{scheme}://{host}" for host in hosts if valid_host(host) for scheme in ("https", "http")}
    origins |= {origin for origin in (first_party(key)[0] for key in keys) if valid_host(urlsplit(origin).hostname or "")}
    # Site storage is cleared from a tab of its own: the browser target refuses it.
    target = client.call("Target.createTarget", {"url": "about:blank", "background": True})["targetId"]
    try:
        session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
        for key in keys:
            try:
                client.call("Storage.clearDataForStorageKey", {"storageKey": key, "storageTypes": "all"},
                            session_id=session)
            except RuntimeError:
                # A key the browser cannot read is checked below like any other: never a success.
                pass
        for origin in sorted(origins):
            client.call("Storage.clearDataForOrigin", {"origin": origin, "storageTypes": "all"},
                        session_id=session)
    finally:
        client.call("Target.closeTarget", {"targetId": target})
    remaining = len(matching(client, hosts))
    for key in keys:
        found = probe(client, *first_party(key)) if left() > 6 else None
        if found is None:
            return None
        remaining += found
    return remaining


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
        remaining = sign_out(client, hosts, keys)
    finally:
        if process is not None:
            stop_headless(process, client)
    out({"ok": True, "remaining": remaining})


main()
`;
