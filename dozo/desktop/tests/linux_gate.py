"""Runs the Linux app against two local sites and checks what loads where (src/frames_gtk.rs).

Usage: xvfb-run -a dbus-run-session -- python3 tests/linux_gate.py <path to the dozo-desktop binary>
Needs xdotool, xprop, openbox and wmctrl. The app's server is site A; site B is another origin. A fake
xdg-open records what the app hands the browser. A second part runs the app under a window manager
and checks what a second launch and closing the window do (src/background.rs). The session bus is
a fresh one without a tray host, which is the case where a hidden window could not come back.
Exit 0 pass, 2 fail.
"""

import http.server
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time

seen = {"a": [], "b": []}
step = {"now": "wait"}


def site(name, pages):
    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            path = self.path.split("?")[0]
            seen[name].append(path)
            body = step["now"] if path == "/step" else pages.get(path, "")
            self.send_response(200)
            self.send_header("Content-Type", "text/html")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body.encode())

        def log_message(self, *args):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"


def sandbox(server, settings=""):
    """A home of its own with the server (and any settings lines) saved, and the environment for it."""
    work = pathlib.Path(tempfile.mkdtemp(prefix="dozo-gate-"))
    home = work / "home"
    config = home / ".config/dev.ssilistre.dozo"
    config.mkdir(parents=True)
    (config / "server").write_text(server + "/\n" + settings)
    opened = work / "opened"
    bin_dir = work / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "xdg-open"
    fake.write_text(f'#!/bin/sh\necho "$1" >> "{opened}"\n')
    fake.chmod(0o755)
    # CI runners set the XDG folders; the app must read this test's home only.
    env = dict(
        os.environ,
        HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_DATA_HOME=str(home / ".local/share"),
        XDG_CACHE_HOME=str(home / ".cache"),
        PATH=f"{bin_dir}:{os.environ['PATH']}",
    )
    return work, opened, env


def windows(visible=True):
    """The app's windows (titled Dozo), by default only those on screen."""
    args = ["xdotool", "search"] + (["--onlyvisible"] if visible else []) + ["--name", "^Dozo$"]
    out = subprocess.run(args, capture_output=True, text=True).stdout
    return out.split()


def until(what, check, seconds=30):
    end = time.time() + seconds
    while time.time() < end:
        if check():
            print(f"ok: {what}")
            return
        time.sleep(0.2)
    print(f"FAIL: timed out: {what}")
    sys.exit(2)


def stays(what, check, seconds=3):
    """True for the whole time: a process that is still there, a window that stays away."""
    end = time.time() + seconds
    while time.time() < end:
        if not check():
            print(f"FAIL: {what}")
            sys.exit(2)
        time.sleep(0.2)
    print(f"ok: {what}")


def background_gate(binary, server):
    """Second launch, closing the window with and without Keep Running in Background."""
    wm = subprocess.Popen(["openbox"], stderr=subprocess.DEVNULL)
    apps = []

    def start(settings="", *args):
        work, _, env = sandbox(server, settings)
        app = subprocess.Popen([binary, *args], env=env, stderr=(work / "app.log").open("w"))
        apps.append(app)
        return app, env

    try:
        time.sleep(1)  # the window manager is up before the first window
        # A second launch opens no new process and no new window: it shows the first one.
        first, env = start()
        until("the window is on screen", lambda: len(windows()) == 1)
        second = subprocess.Popen([binary], env=env, stderr=subprocess.DEVNULL)
        until("a second launch ends by itself", lambda: second.poll() == 0)
        stays("and the first app keeps its one window", lambda: first.poll() is None and len(windows()) == 1)

        # Keep Running in Background off: closing the window ends the app, as before.
        wmctrl_close()
        until("closing the window with the switch off ends the app", lambda: first.poll() is not None)

        # On, with no tray to bring a hidden window back: closing minimizes, nothing is hidden,
        # and a second launch brings the window back.
        kept, env = start("keep_running=true\n")
        until("the window is on screen again", lambda: len(windows()) == 1)
        wmctrl_close()
        until("closing the window with the switch on takes it off the screen", lambda: not windows())
        stays("and the app keeps running", lambda: kept.poll() is None)
        # Minimized, not hidden: the window manager lists it as iconic (a hidden one is withdrawn)
        # and keeps it for the taskbar to restore.
        until("the window is minimized, not hidden or destroyed", lambda: any(
            "Iconic" in subprocess.run(["xprop", "-id", w, "WM_STATE"], capture_output=True, text=True).stdout
            for w in windows(visible=False)
        ))
        returned = subprocess.Popen([binary], env=env, stderr=subprocess.DEVNULL)
        until("a second launch ends by itself again", lambda: returned.poll() == 0)
        until("and the window is back", lambda: len(windows()) == 1)
        stays("with the first app still running", lambda: kept.poll() is None)
        kept.kill()
        until("the app ends", lambda: kept.wait() is not None)

        # Started by the login entry, with no tray: the window shows, never a hidden process.
        login, _ = start("keep_running=true\n", "--from-login")
        until("a login start with no tray shows the window", lambda: len(windows()) == 1)
        stays("and runs", lambda: login.poll() is None)
    finally:
        for app in apps:
            app.kill()
        wm.kill()


def wmctrl_close():
    subprocess.run(["wmctrl", "-c", "Dozo"], check=True)


def main():
    binary = os.path.abspath(sys.argv[1])
    b = site(
        "b",
        {
            # The frame says it ran, then tries to open a mail app without a click.
            "/frame": "<script>fetch('/frame-ok').then(() => "
            "{ location.href = 'mailto:nobody@example.invalid' })</script>",
        },
    )
    a = site(
        "a",
        {
            # A link over the top of the page, a frame from B, and a script the test steers.
            "/": f"""<body style="margin:0">
<a href="{b}/clicked" style="position:absolute;top:0;left:0;width:400px;height:80px;
display:block;background:#333">out</a>
<iframe src="{b}/frame" style="position:absolute;top:120px;left:0"></iframe>
<script>
setInterval(async () => {{
  const now = await (await fetch('/step')).text();
  if (now === 'away') location.href = '{b}/script-away';
  if (now === 'same') location.href = '/next';
}}, 300);
</script></body>""",
            "/next": "<script>fetch('/next-ok')</script>",
        },
    )

    work, opened, env = sandbox(a)
    log = work / "app.log"
    app = subprocess.Popen([binary], env=env, stderr=log.open("w"))

    def wait(what, check, seconds=30):
        end = time.time() + seconds
        while time.time() < end:
            if check():
                print(f"ok: {what}")
                return
            time.sleep(0.2)
        fail(f"timed out: {what}")

    def outside():
        return opened.read_text().split() if opened.exists() else []

    def fail(message):
        print(f"FAIL: {message}\n  site A: {seen['a']}\n  site B: {seen['b']}\n  opened: {outside()}")
        print(f"  app exit: {app.poll()}\n  app stderr:\n{log.read_text()[-3000:]}")
        app.kill()
        sys.exit(2)

    try:
        wait("a frame from another site loads and runs", lambda: "/frame-ok" in seen["b"])
        # Menu bar (about 25 px) above the page, no window manager: the link is near the top.
        subprocess.run(["xdotool", "mousemove", "200", "65", "click", "1"], check=True)
        wait("a clicked link to another site opens in the browser", lambda: f"{b}/clicked" in outside())
        time.sleep(1)
        if "/clicked" in seen["b"]:
            fail("the clicked link was requested by the app")
        if any(url.startswith("mailto:") for url in outside()):
            fail("a frame opened a mail app without a click")
        step["now"] = "away"
        wait("the page's script asks for another site", lambda: "/script-away" in seen["b"])
        count = seen["a"].count("/step")
        wait("the page stays after that", lambda: seen["a"].count("/step") > count + 3)
        wait("and that site opens in the browser", lambda: f"{b}/script-away" in outside())
        step["now"] = "same"
        wait("a page on the same server loads", lambda: "/next-ok" in seen["a"])
        app.kill()
        app.wait()
        background_gate(binary, a)
        print("linux gate: PASS")
    finally:
        app.kill()


if __name__ == "__main__":
    main()
