"""Runs the Linux app against two local sites and checks what loads where (src/frames_gtk.rs).

Usage: xvfb-run -a python3 tests/linux_gate.py <path to the dozo-desktop binary>
Needs xdotool. The app's server is site A; site B is another origin. A fake xdg-open records
what the app hands the browser. Exit 0 pass, 2 fail.
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

    work = pathlib.Path(tempfile.mkdtemp(prefix="dozo-gate-"))
    config = work / "home/.config/dev.ssilistre.dozo"
    config.mkdir(parents=True)
    (config / "server").write_text(a + "/")
    opened = work / "opened"
    bin_dir = work / "bin"
    bin_dir.mkdir()
    fake = bin_dir / "xdg-open"
    fake.write_text(f'#!/bin/sh\necho "$1" >> "{opened}"\n')
    fake.chmod(0o755)
    env = dict(os.environ, HOME=str(work / "home"), PATH=f"{bin_dir}:{os.environ['PATH']}")
    app = subprocess.Popen([binary], env=env, stderr=subprocess.DEVNULL)

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
        print("linux gate: PASS")
    finally:
        app.kill()


if __name__ == "__main__":
    main()
