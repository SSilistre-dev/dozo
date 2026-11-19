"""The signed-in sites script against a real browser in the bot computer image, with no network.

Run by site-sessions-image.sh inside the image. Pages are answered by this test over the browser's
debugging connection (Fetch), so any https site can be "visited" offline. It checks what the script
lists (hosts, times, top-level visits, storage keys; never a value) and that signing out removes
exactly one site's cookies and storage, partitioned ones included, with the browser running and
with it stopped.
"""
import base64, json, os, re, subprocess, sys, time

sys.path.insert(0, "/usr/local/lib/rakazo")
from page_secrets import CdpClient, discover_ws_url  # noqa: E402

HOME = os.environ["HOME"]
SOURCE = open("/src/dozo-site-sessions.script.ts").read()
SCRIPT = SOURCE[SOURCE.index("String.raw`") + 11:SOURCE.rindex("`;")].replace("/home/rakazo", HOME)
PROFILE = f"{HOME}/.browser-profiles/chromium-bot-" + "e" * 32
SECRET = "VALUE-NEVER-LISTED"
STORE = ("<script>localStorage.setItem('k', 'v'); indexedDB.open('d');"
         " caches.open('c').then(() => document.title = 'stored'); document.title = 'stored'</script>")
failures = []


def check(ok, what):
    print(("ok   " if ok else "FAIL ") + what)
    if not ok:
        failures.append(what)


def run(request):
    done = subprocess.run(["python3", "-I", "-c", SCRIPT, json.dumps({**request, "profile": PROFILE})],
                          capture_output=True, text=True, timeout=70)
    if done.returncode != 0:
        print(done.stderr[-2000:])
    return json.loads(done.stdout)


def start_browser(port):
    process = subprocess.Popen(
        ["chromium", "--headless=new", "--test-type", "--no-sandbox", "--disable-dev-shm-usage",
         "--disable-gpu", "--password-store=basic", "--remote-debugging-address=127.0.0.1",
         f"--remote-debugging-port={port}", f"--user-data-dir={PROFILE}", "about:blank"],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(150):
        try:
            client = CdpClient(discover_ws_url(port))
            client.connect()
            return process, client
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    raise RuntimeError("test browser did not start")


def visit(client, url, pages):
    """Opens url at the top level; every request it makes is answered from pages (url -> (headers, body))."""
    target = client.call("Target.createTarget", {"url": "about:blank"})["targetId"]
    session = client.call("Target.attachToTarget", {"targetId": target, "flatten": True})["sessionId"]
    client.call("Fetch.enable", {"patterns": [{"urlPattern": "*"}]}, session_id=session)
    client.call("Runtime.enable", session_id=session)
    queue = []
    handle = client._handle_event
    client._handle_event = lambda m: queue.append(m) if m.get("method") == "Fetch.requestPaused" else handle(m)
    client._send(0x1, json.dumps({"id": 800000, "method": "Page.navigate", "params": {"url": url},
                                  "sessionId": session}).encode())
    served, deadline = 0, time.time() + 10
    while served < len(pages) and time.time() < deadline:
        if not queue:
            client._sock.settimeout(0.5)
            try:
                message = json.loads(client._read_frame().decode())
            except (OSError, ValueError):
                continue
            if message.get("method") == "Fetch.requestPaused":
                queue.append(message)
            continue
        message = queue.pop(0)
        asked = message["params"]["request"]["url"]
        headers, body = pages.get(asked, ([], ""))
        served += 1 if asked in pages else 0
        client.call("Fetch.fulfillRequest", {
            "requestId": message["params"]["requestId"], "responseCode": 200,
            "responseHeaders": [{"name": "Content-Type", "value": "text/html"}] + headers,
            "body": base64.b64encode(body.encode()).decode()}, session_id=message.get("sessionId"))
    time.sleep(1.5)
    client._handle_event = handle
    return target


def cookie(value):
    return {"name": "Set-Cookie", "value": value}


def own_cookies(client):
    return sorted((c["domain"], c["name"], bool(c.get("partitionKey"))) for c in client.call("Storage.getCookies")["cookies"])


os.makedirs(PROFILE, exist_ok=True)
process, client = start_browser(9311)
sites = {
    "https://example.com/": [cookie(f"sid={SECRET}; Path=/; Max-Age=86400"),
                             cookie(f"d={SECRET}; Domain=example.com; Path=/; Max-Age=86400")],
    "https://a.example.com/": [cookie(f"sub={SECRET}; Path=/; Max-Age=86400")],
    "https://notexample.com/": [cookie(f"n={SECRET}; Path=/; Max-Age=86400")],
    "https://example.com.evil.org/": [cookie(f"e={SECRET}; Path=/; Max-Age=86400")],
    "https://alice.github.io/": [cookie(f"a={SECRET}; Path=/; Max-Age=86400")],
    "https://bob.github.io/": [cookie(f"b={SECRET}; Path=/; Max-Age=86400")],
    "http://10.0.0.5/": [cookie(f"ip={SECRET}; Path=/; Max-Age=86400")],
    "https://xn--bcher-kva.example/": [cookie(f"idn={SECRET}; Path=/; Max-Age=86400")],
}
for url, headers in sites.items():
    visit(client, url, {url: (headers, STORE)})
# example.com embedded under another site: a partitioned cookie and partitioned storage.
visit(client, "https://top.example/", {
    "https://top.example/": ([], "<iframe src='https://example.com/frame'></iframe>"),
    "https://example.com/frame": ([], STORE.replace("<script>", "<script>document.cookie = "
                                  f"'p={SECRET}; Path=/; Secure; SameSite=None; Partitioned; Max-Age=86400';", 1))})
# A tracker that only ever loads inside another site's page.
visit(client, "https://news.example/", {
    "https://news.example/": ([], "<iframe src='https://tracker.example/pixel'></iframe>"),
    "https://tracker.example/pixel": ([cookie(f"t={SECRET}; Path=/; Secure; SameSite=None; Max-Age=86400")], "")})
before = own_cookies(client)
check(("example.com", "p", True) in before, "the partitioned cookie of example.com under top.example is set")
check(any(d == "tracker.example" for d, _, _ in before), "the tracker's third-party cookie is set")

listed = run({"op": "list"})
text = json.dumps(listed)
check(listed["ok"] and SECRET not in text, "list carries no cookie value")
hosts = {h["host"] for h in listed["hosts"]}
check({"example.com", "a.example.com", "notexample.com", "example.com.evil.org", "alice.github.io",
       "bob.github.io", "10.0.0.5", "xn--bcher-kva.example", "tracker.example"} <= hosts, "list has every cookie host")
check(all(h["created"] is None or h["created"] > 0 for h in listed["hosts"]), "times are milliseconds or unknown")
visited = set(listed["visited"])
check({"example.com", "top.example", "news.example", "alice.github.io"} <= visited, "top-level visits are listed")
check("tracker.example" not in visited, "a site only seen inside another page is not a visit")
keys = listed["storageKeys"]
partitioned = [k for k in keys if k.startswith("https://example.com") and "^0https://top.example" in k]
check(bool(partitioned), "the partitioned storage key of example.com is listed")
check(any(k.startswith("https://alice.github.io") for k in keys), "alice.github.io's storage key is listed")

# Signing out of example.com with the browser running: exactly its hosts and storage keys.
example_keys = [k for k in keys if re.match(r"https?://(a\.)?example\.com(:\d+)?/", k.split("^0")[0] + "/")]
done = run({"op": "delete", "hosts": ["example.com", "a.example.com", "www.example.com"], "storageKeys": example_keys})
check(done == {"ok": True, "remaining": 0}, f"signing out of example.com while running reports nothing left ({done})")
after = own_cookies(client)
check(not any(d.lstrip(".") in ("example.com", "a.example.com") for d, _, _ in after),
      "every example.com cookie is gone, the partitioned one included")
check({d for d, _, _ in after} >= {"notexample.com", "example.com.evil.org", "alice.github.io", "bob.github.io",
                                   "10.0.0.5", "xn--bcher-kva.example"}, "other sites' cookies stay")
relisted = run({"op": "list"})
check(not {"example.com", "a.example.com"} & {h["host"] for h in relisted["hosts"]}, "example.com drops off the list")

# The same with the browser stopped: the script starts its own on the profile.
client.call("Browser.close")
process.wait(10)
for site, extra in (("alice.github.io", []), ("10.0.0.5", []), ("xn--bcher-kva.example", [])):
    site_keys = [k for k in run({"op": "list"})["storageKeys"] if k.split("^0")[0].split("/")[2].split(":")[0] == site]
    done = run({"op": "delete", "hosts": [site, f"www.{site}", *extra], "storageKeys": site_keys})
    check(done == {"ok": True, "remaining": 0}, f"signing out of {site} while stopped reports nothing left ({done})")
stopped = {h["host"] for h in run({"op": "list"})["hosts"]}
check(not {"alice.github.io", "10.0.0.5", "xn--bcher-kva.example"} & stopped, "stopped sign-outs drop off the list")
check({"bob.github.io", "notexample.com", "example.com.evil.org"} <= stopped, f"their neighbours stay ({sorted(stopped)})")
bad = subprocess.run(["python3", "-I", "-c", SCRIPT, json.dumps({"op": "list", "profile": "/etc/passwd"})],
                     capture_output=True, text=True, timeout=30)
check(json.loads(bad.stdout) == {"ok": False, "error": "profile"}, "a profile outside the bots' folder is refused")
print("SITE-SESSIONS-IMAGE:", "PASS" if not failures else f"FAIL ({len(failures)})")
sys.exit(0 if not failures else 2)
