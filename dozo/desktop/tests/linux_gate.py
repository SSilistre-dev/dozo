"""Runs the Linux app against two local sites and checks what loads where (src/frames_gtk.rs).

Usage: xvfb-run -a dbus-run-session -- python3 tests/linux_gate.py <path to the dozo-desktop binary>
Needs xdotool, xprop, openbox and wmctrl. The app's server is site A; site B is another origin. A fake
xdg-open records what the app hands the browser. A second part runs the app under a window manager
and checks what a second launch and closing the window do (src/background.rs). The session bus is
a fresh one without a tray host, which is the case where a hidden window could not come back.
A third part checks notifications and the unread badge (src/alerts.rs) against a stand-in for the
desktop's notification service (tests/fake_notifications.py, which needs python3-gi). A fourth
checks the microphone (src/alerts.rs, src/microphone_gtk.rs) against a PulseAudio sine source and
Push to Talk (src/talk.rs): the shortcut reaches the server's page, brings the window back, and a
shortcut another program holds turns the switch off with a message (needs pulseaudio and
gstreamer1.0-pulseaudio). A fifth checks the bridge of the server's page (src/page_bridge.rs): what
it may read and set, that frames have none, that bad requests change nothing, that a sensitive
switch only asks in the app's own window, which Enter cancels, and that a burst is cut off.
Exit 0 pass, 2 fail.
"""

import http.server
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import threading
import time
import urllib.parse

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


def notify_gate(binary):
    """Only the server's origin may notify, a click on a notification brings the window back, and
    titles with or without a count leave the app running with its own title."""
    report = {"a": [], "b": []}
    titles = {"now": ""}

    def reporting(name, pages):
        def page(path):
            return pages.get(path)

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path, _, query = self.path.partition("?")
                if path == "/report":
                    report[name].append(query)
                body = titles["now"] if path == "/title" else page(path) or ""
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

    # Asks for permission on a click anywhere in its document (WebKitGTK wants one), says who asked
    # and what it got, and shows one notification if it may. Two frames ask on a click too: one
    # from another origin and one from the server's, so the origin is what tells them apart.
    ask = """<body style="margin:0;height:100vh"><script>document.body.onclick = () => (async () => {{
  const before = Notification.permission;
  const result = await Notification.requestPermission();
  document.title = 'permission ' + result;
  await fetch('/report?who={who}&before=' + before + '&result=' + result);
  if (result === 'granted') {{
    const shown = new Notification('{summary}', {{ body: 'gate' }});
    shown.onclick = () => fetch('/report?clicked');
  }}
}})();</script>"""
    other = reporting("b", {"/frame": ask.format(who="other", summary="from-the-other-frame")})
    frame = "position:fixed;top:0;width:200px;height:120px;border:0"
    server = reporting("a", {
        "/same": ask.format(who="same", summary="from-the-same-frame"),
        "/": ask.format(who="server", summary="from-the-server")
        + f"""<iframe src="{other}/frame" style="{frame};left:0"></iframe>
<iframe src="/same" style="{frame};left:240px"></iframe>
<script>setInterval(async () => {{
  const next = await (await fetch('/title')).text();
  if (next && document.title !== next) document.title = next;
}}, 200);</script>""",
    })

    service = pathlib.Path(tempfile.mkdtemp(prefix="dozo-notify-"))
    fake = subprocess.Popen([sys.executable, str(pathlib.Path(__file__).with_name("fake_notifications.py")), str(service)])
    wm = subprocess.Popen(["openbox"], stderr=subprocess.DEVNULL)
    work, _, env = sandbox(server, "keep_running=true\n")
    app = None
    try:
        until("the stand-in notification service is up", lambda: (service / "ready").exists())
        app = subprocess.Popen([binary], env=env, stderr=(work / "app.log").open("w"))

        def shown():
            return (service / "shown").read_text().split("\n") if (service / "shown").exists() else []

        def check(what, condition):
            if not condition:
                print(f"FAIL: {what}\n  server: {report['a']}\n  frame: {report['b']}\n  shown: {shown()}")
                print(f"  app stderr:\n{(work / 'app.log').read_text()[-3000:]}")
                sys.exit(2)
            print(f"ok: {what}")

        def asked(who):
            return [r for r in report["a"] + report["b"] if r.startswith(f"who={who}&")]

        def click(x, y):
            subprocess.run(["xdotool", "mousemove", "--window", windows()[0], str(x), str(y), "click", "1"], check=True)

        until("the window is on screen", lambda: len(windows()) == 1)
        time.sleep(1)  # the page and its frames have loaded and listen for clicks
        # Below the menu bar, inside each frame, then on the page itself.
        click(100, 90)
        until("a frame from another origin asked on a click", lambda: asked("other"))
        check("and is denied notifications", asked("other")[0] == "who=other&before=default&result=denied")
        click(340, 90)
        until("a frame from the server's origin asked on a click", lambda: asked("same"))
        check("and is granted them: the origin decides", asked("same")[0] == "who=same&before=default&result=granted")
        click(600, 400)
        until("the server's page asked", lambda: asked("server"))
        check("the server's origin is granted them", asked("server")[0].endswith("&result=granted"))
        until("the server's notification reaches the desktop", lambda: any(" from-the-server" in line for line in shown()))
        check("and nothing from the other origin does", not any("from-the-other-frame" in line for line in shown()))

        # Closing with Keep Running in Background and no tray takes the window off the screen;
        # a click on the notification brings it back, and the page hears the click.
        wmctrl_close()
        until("closing the window takes it off the screen", lambda: not windows())
        ident = next(line.split()[0] for line in shown() if line.endswith(" from-the-server"))
        (service / "click").write_text(ident)
        until("a click on the notification brings the window back", lambda: len(windows()) == 1)
        until("and the page hears the click", lambda: "clicked" in report["a"])

        # The count in front of the title, broken titles and none: the app keeps running and the
        # window keeps its own title.
        for title in ["(3) Gate", "(9999+) Gate", "(99999999999999999999) Gate", "(abc) Gate", "(3 Gate", "(0) Gate", "Gate"]:
            titles["now"] = title
            time.sleep(0.6)
        stays("titles with and without a count leave the app running as Dozo", lambda: app.poll() is None and len(windows()) == 1)
    finally:
        if app:
            app.kill()
        fake.kill()
        wm.kill()


def grab_shortcut():
    """Another program holding Ctrl+Shift+Space, as a desktop's own shortcut would: an X connection
    that grabs it (with and without NumLock and CapsLock) and keeps it until closed."""
    import ctypes
    x11 = ctypes.cdll.LoadLibrary("libX11.so.6")
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XGrabKey.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_uint, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    display = x11.XOpenDisplay(None)
    root = x11.XDefaultRootWindow(display)
    space = x11.XKeysymToKeycode(display, 0x20)
    for extra in (0, 2, 16, 18):  # none, CapsLock, NumLock, both
        x11.XGrabKey(display, space, 1 | 4 | extra, root, 1, 1, 1)  # Shift | Control
    x11.XSync(display, 0)
    return x11, display


def talk_gate(binary):
    """The server's page may use the microphone and nothing else may; Push to Talk reaches that
    page only, brings the window back, and a shortcut held by another program turns it off with a
    message instead of failing silently."""
    report = {"a": [], "b": []}

    def reporting(name, pages):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path, _, query = self.path.partition("?")
                if path == "/report":
                    report[name].append(query)
                self.send_response(200)
                self.send_header("Content-Type", "text/html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(pages.get(path, "").encode())

            def log_message(self, *args):
                pass

        server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        return f"http://127.0.0.1:{server.server_address[1]}"

    # On a click: the microphone, the camera, then both, each reported as granted or the error's
    # name. The page also reports every push-to-talk event it hears.
    ask = """<body style="margin:0;height:100vh"><script>
addEventListener('dozo-talk-key', (e) => fetch('/report?key=' + e.detail));
document.body.onclick = async () => {{
  for (const [what, wants] of [['audio', {{ audio: true }}], ['video', {{ video: true }}], ['both', {{ audio: true, video: true }}]]) {{
    let result;
    try {{
      const stream = await navigator.mediaDevices.getUserMedia(wants);
      stream.getTracks().forEach((track) => track.stop());
      result = 'granted';
    }} catch (error) {{
      result = error.name;
    }}
    await fetch('/report?who={who}&' + what + '=' + result);
  }}
}};</script>"""
    other = reporting("b", {"/frame": ask.format(who="other")})
    server = reporting("a", {
        "/": ask.format(who="server")
        + f"""<iframe src="{other}/frame" style="position:fixed;top:0;left:0;width:200px;height:120px;border:0"></iframe>""",
    })

    # A sound server of its own with one microphone that plays a tone, on a socket the app finds
    # without a cookie: the app's home is a fresh one.
    socket = pathlib.Path(tempfile.mkdtemp(prefix="dozo-pulse-")) / "native"
    pulse = subprocess.run([
        "pulseaudio", "-n", "--daemonize=yes", "--exit-idle-time=-1",
        f"--load=module-native-protocol-unix socket={socket} auth-anonymous=1",
        "--load=module-sine-source source_name=gate",
    ], capture_output=True, text=True)
    if pulse.returncode != 0:
        print(f"FAIL: pulseaudio did not start: {pulse.stderr.strip()}")
        sys.exit(2)
    os.environ["PULSE_SERVER"] = f"unix:{socket}"
    wm = subprocess.Popen(["openbox"], stderr=subprocess.DEVNULL)
    apps = []
    try:
        work, _, env = sandbox(server, "keep_running=true\npush_to_talk=true\n")
        app = subprocess.Popen([binary], env=env, stderr=(work / "app.log").open("w"))
        apps.append(app)

        def check(what, condition):
            if not condition:
                print(f"FAIL: {what}\n  server: {report['a']}\n  frame: {report['b']}")
                print(f"  app stderr:\n{(work / 'app.log').read_text()[-3000:]}")
                sys.exit(2)
            print(f"ok: {what}")

        def answers(name, who):
            """What `who` got for each request, once it has asked for all three."""
            got = dict(r.split("&", 1)[1].split("=", 1) for r in report[name] if r.startswith(f"who={who}&"))
            return got if "both" in got else None

        def click(x, y):
            subprocess.run(["xdotool", "mousemove", "--window", windows()[0], str(x), str(y), "click", "1"], check=True)

        def shortcut(action):
            subprocess.run(["xdotool", action, "ctrl+shift+space"], check=True)

        until("the window is on screen", lambda: len(windows()) == 1)
        time.sleep(1)  # the page and its frame have loaded
        click(100, 90)
        until("a frame from another origin asked for the microphone and the camera", lambda: answers("b", "other"))
        check("and was given neither", "granted" not in answers("b", "other").values())
        click(600, 400)
        until("the server's page asked for them", lambda: answers("a", "server"))
        got = answers("a", "server")
        check(f"the server's page is given the microphone ({got})", got["audio"] == "granted")
        check("and not the camera, alone or with the microphone", got["video"] != "granted" and got["both"] != "granted")

        shortcut("keydown")
        until("the shortcut down reaches the server's page", lambda: "key=down" in report["a"])
        shortcut("keyup")
        until("and so does up", lambda: "key=up" in report["a"])
        check("the frame from another origin hears neither", not any(r.startswith("key=") for r in report["b"]))
        wmctrl_close()
        until("closing the window takes it off the screen", lambda: not windows())
        shortcut("keydown")
        until("the shortcut brings the window back", lambda: len(windows()) == 1)
        shortcut("keyup")
        until("and the page hears it again", lambda: report["a"].count("key=up") == 2)
        app.kill()
        app.wait()

        # Another program holds the shortcut: the switch goes off, is saved off, and a message
        # says so (a second window titled Dozo).
        x11, display = grab_shortcut()
        work, _, env = sandbox(server, "push_to_talk=true\n")
        app = subprocess.Popen([binary], env=env, stderr=(work / "app.log").open("w"))
        apps.append(app)
        settings = work / "home/.config/dev.ssilistre.dozo/server"
        until("a shortcut held elsewhere turns Push to Talk off and saves it", lambda: "push_to_talk" not in settings.read_text())
        until("and a message says so", lambda: len(windows()) == 2)
        stays("and the app keeps running", lambda: app.poll() is None)
        x11.XCloseDisplay(display)
    finally:
        for app in apps:
            app.kill()
        wm.kill()
        subprocess.run(["pactl", "exit"], capture_output=True)
        os.environ.pop("PULSE_SERVER", None)


def bridge_gate(binary):
    """The server's page reads the app's switches and sets the harmless ones through its bridge
    (src/page_bridge.rs); a frame inside it, from another origin or its own, has no bridge; a bad
    request changes nothing; a sensitive switch only asks, in a window of the app's own that Enter
    cancels; and a burst of calls is cut off."""
    report = {"a": [], "b": []}
    steps = {"now": "wait"}

    def reporting(name, pages):
        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                path, _, query = self.path.partition("?")
                if path == "/report":
                    report[name].append(urllib.parse.parse_qs(query))
                body = steps["now"] if path == "/step" else pages.get(path, "")
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

    frame = """<script>
let up;
try { up = typeof top.dozoDesktop; } catch (error) { up = error.name; }
fetch('/report?' + new URLSearchParams({ who: '{who}', bridge: typeof window.dozoDesktop,
  internals: typeof window.__TAURI_INTERNALS__, up }));
</script>"""
    other = reporting("b", {"/frame": frame.replace("{who}", "other")})
    server = reporting("a", {
        "/same": frame.replace("{who}", "same"),
        "/": f"""<body><iframe src="{other}/frame"></iframe><iframe src="/same"></iframe><script>
const report = (what) => fetch('/report?' + new URLSearchParams(what));
const step = async (name) => {{
  while ((await (await fetch('/step')).text()) !== name) await new Promise((go) => setTimeout(go, 200));
}};
(async () => {{
  const bridge = window.dozoDesktop;
  report({{ who: 'page', bridge: typeof bridge }});
  if (!bridge) return;
  const first = await bridge.settings(null);
  report({{ step: 'read', state: JSON.stringify(first) }});
  const answers = [
    await bridge.set('keepRunning', true),
    await bridge.set('openAtLogin', 'yes'),
    await bridge.set('relay', true),
    await bridge.set('KeepRunning', false),
    await bridge.open('back-up'),
  ];
  report({{ step: 'answers', answers: JSON.stringify(answers) }});
  const second = await bridge.settings(first);
  report({{ step: 'after', state: JSON.stringify(second) }});
  await bridge.set('passwordManager', true);
  await bridge.set('passwordManager', true);
  report({{ step: 'asked' }});
  await step('burst');
  const burst = await Promise.all(Array.from({{ length: 30 }}, () => bridge.settings(null)));
  report({{ step: 'burst', refused: String(burst.filter((answer) => answer === null).length) }});
}})();
</script></body>""",
    })
    wm = subprocess.Popen(["openbox"], stderr=subprocess.DEVNULL)
    app = None
    try:
        work, _, env = sandbox(server)
        app = subprocess.Popen([binary], env=env, stderr=(work / "app.log").open("w"))
        settings = work / "home/.config/dev.ssilistre.dozo/server"

        def check(what, condition):
            if not condition:
                print(f"FAIL: {what}\n  server: {report['a']}\n  frame: {report['b']}")
                print(f"  app stderr:\n{(work / 'app.log').read_text()[-3000:]}")
                sys.exit(2)
            print(f"ok: {what}")

        def got(name, key, value):
            return next((r for r in report[name] if r.get(key) == [value]), None)

        def state(name):
            return json.loads(got("a", "step", name)["state"][0])

        def switches(name):
            return {entry["key"]: entry["on"] for entry in state(name)["switches"]}

        until("the server's page has the bridge", lambda: got("a", "who", "page"))
        check("it is the app's", got("a", "who", "page")["bridge"] == ["object"])
        until("and reads the switches", lambda: got("a", "step", "read"))
        check("with the version", state("read")["version"].count(".") == 2)
        check("Keep Running in Background is off", switches("read").get("keepRunning") is False)
        until("a frame from another origin has loaded", lambda: got("b", "who", "other"))
        other_frame = got("b", "who", "other")
        check(f"and has no bridge and no way to the app ({other_frame})",
              other_frame["bridge"] == ["undefined"] and other_frame["internals"] == ["undefined"]
              and other_frame["up"] == ["SecurityError"])
        until("a frame of the server's own has loaded", lambda: got("a", "who", "same"))
        check("and has no bridge of its own", got("a", "who", "same")["bridge"] == ["undefined"])
        until("the page changed a switch", lambda: got("a", "step", "after"))
        check("every write answers the same nothing",
              json.loads(got("a", "step", "answers")["answers"][0]) == [None] * 5)
        check("Keep Running in Background is on", switches("after").get("keepRunning") is True)
        check("and saved", "keep_running=true" in settings.read_text())
        check("a wrong type, an unknown name or another case changed nothing",
              "open_at_login=false" in settings.read_text() and "relay" not in settings.read_text())
        until("the page asked for the password manager", lambda: got("a", "step", "asked"))
        until("the app asks the person in a window of its own", lambda: len(windows()) == 2)
        stays("only one, though the page asked twice", lambda: len(windows()) == 2, seconds=2)
        check("nothing is turned on before an answer", "password_manager" not in settings.read_text())
        subprocess.run(["xdotool", "key", "Return"], check=True)
        until("Enter cancels the question", lambda: len(windows()) == 1)
        stays("and the password manager stays off", lambda: "password_manager" not in settings.read_text())
        steps["now"] = "burst"
        until("the page sent a burst of calls", lambda: got("a", "step", "burst"))
        refused = int(got("a", "step", "burst")["refused"][0])
        check(f"and the app answered only some of them ({30 - refused} of 30)", 15 <= refused < 30)
    finally:
        if app:
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
        notify_gate(binary)
        talk_gate(binary)
        bridge_gate(binary)
        print("linux gate: PASS")
    finally:
        app.kill()


if __name__ == "__main__":
    main()
