"""The app's own window through a hosted sign-in, run by hosted_login_window.sh in its container.

The computer's server (http://127.0.0.1:5173) and the hosted server (http://localhost:6173) answer
on this container's loopback. The app opens the computer's server, saved as its server; the test
drives the window through WebKit's WebDriver (tauri-driver) as a person would: the one button,
the hosted sign-up, the page that asks to agree, back to the computer. A fake xdg-open records
anything handed to the browser instead: nothing may be. Exit 0 pass, 2 fail.
"""

import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.request

LOCAL = "http://127.0.0.1:5173"
HOSTED = "http://localhost:6173"
DRIVER = "http://127.0.0.1:4444"
EMAIL = f"window.{int(time.time())}@dozo.example"


def fail(what):
    print(f"FAIL: {what}")
    sys.exit(2)


def call(method, path, body=None):
    data = None if body is None else json.dumps(body).encode()
    request = urllib.request.Request(f"{DRIVER}{path}", data=data, method=method)
    request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return json.loads(response.read() or b"{}").get("value")
    except urllib.error.HTTPError as error:
        return {"error": json.loads(error.read() or b"{}").get("value")}
    except (urllib.error.URLError, ConnectionError):
        return None  # not listening yet


def until(what, check, seconds=60):
    end = time.time() + seconds
    while time.time() < end:
        got = check()
        if got:
            print(f"ok: {what}")
            return got
        time.sleep(0.3)
    fail(f"timed out: {what}")


# A home of its own with the computer's server saved, and a browser that only records.
work = pathlib.Path(tempfile.mkdtemp(prefix="dozo-window-"))
home = work / "home"
(home / ".config/dev.ssilistre.dozo").mkdir(parents=True)
(home / ".config/dev.ssilistre.dozo/server").write_text(LOCAL + "/\n")
opened = work / "opened"
(work / "bin").mkdir()
(work / "bin/xdg-open").write_text(f'#!/bin/sh\necho "$1" >> "{opened}"\n')
(work / "bin/xdg-open").chmod(0o755)
env = dict(
    os.environ,
    HOME=str(home),
    XDG_CONFIG_HOME=str(home / ".config"),
    XDG_DATA_HOME=str(home / ".local/share"),
    XDG_CACHE_HOME=str(home / ".cache"),
    PATH=f"{work}/bin:{os.environ['PATH']}",
)
driver = subprocess.Popen(["/app/tauri-driver", "--port", "4444"], env=env)
until("tauri-driver answers", lambda: "ready" in json.dumps(call("GET", "/status") or {}), 30)

session = call(
    "POST",
    "/session",
    {"capabilities": {"alwaysMatch": {"tauri:options": {"application": "/app/dozo-desktop"}}}},
)
if not isinstance(session, dict) or "sessionId" not in session:
    fail(f"no WebDriver session: {session}")
sid = session["sessionId"]
first_window = call("GET", f"/session/{sid}/window")


def url():
    return call("GET", f"/session/{sid}/url") or ""


def find(xpath):
    found = call("POST", f"/session/{sid}/elements", {"using": "xpath", "value": xpath})
    return [next(iter(item.values())) for item in found] if isinstance(found, list) else []


def click(xpath):
    element = until(f"shows {xpath}", lambda: (find(xpath) or [None])[0])
    result = call("POST", f"/session/{sid}/element/{element}/click", {})
    if isinstance(result, dict) and result.get("error"):
        fail(f"click {xpath}: {result['error']}")


def fill(placeholder, text):
    element = until(f"field {placeholder}", lambda: (find(f"//input[@placeholder='{placeholder}']") or [None])[0])
    call("POST", f"/session/{sid}/element/{element}/value", {"text": text})


def shot(name):
    data = call("GET", f"/session/{sid}/screenshot")
    if isinstance(data, str):
        pathlib.Path(f"/shots/{name}.png").write_bytes(base64.b64decode(data))


def button(text):
    return f"//button[normalize-space(.)='{text}']"


try:
    until("the window opens the computer's sign-in", lambda: url().startswith(LOCAL) and find(button("Continue")), 120)
    shot("1-computer-sign-in")
    click(button("Continue"))
    until("the hosted sign-in loads in the window", lambda: url().startswith(f"{HOSTED}/sign-in"))
    click("//a[normalize-space(.)='Sign up']")
    until("the hosted sign-up", lambda: url().startswith(f"{HOSTED}/sign-up"))
    if find(button("Continue with email")):
        click(button("Continue with email"))
    fill("Your name", "Window")
    fill("Your email address", EMAIL)
    fill("Password", "e2e-password-1234")
    click(button("Create account"))
    until(
        "the page that asks to agree, in the window",
        lambda: url().startswith(f"{HOSTED}/dozo/hosted-login")
        and find("//h1[contains(normalize-space(.), 'Sign in on this computer?')]"),
    )
    shot("2-hosted-agree")
    click(button("Continue"))
    until(
        "back on the computer, signed in",
        lambda: url().startswith(LOCAL) and "/sign-in" not in url() and "/api/" not in url(),
    )
    got = call(
        "POST",
        f"/session/{sid}/execute/async",
        {
            "script": "const done = arguments[arguments.length - 1];"
            "fetch('/api/auth/get-session').then((r) => r.json()).then(done, () => done(null));",
            "args": [],
        },
    )
    email = (got or {}).get("user", {}).get("email") if isinstance(got, dict) else None
    if email != EMAIL:
        fail(f"signed in as {email}, wanted {EMAIL}")
    print(f"ok: the computer's session is {EMAIL}")
    shot("3-signed-in")
    handles = call("GET", f"/session/{sid}/window/handles") or []
    if handles != [first_window]:
        fail(f"one window throughout, got {handles}")
    if opened.exists() and opened.read_text().strip():
        fail(f"handed to the browser: {opened.read_text().strip()}")
    print("ok: one window, nothing handed to the browser")
finally:
    call("DELETE", f"/session/{sid}")
    driver.terminate()
print("PASS")
