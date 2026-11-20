# Dozo for macOS, Windows and Linux

A small native window around the Dozo web app, written in Rust with Tauri 2. It is the fork's own
shell. Upstream's Electron app in `apps/desktop` is separate and is neither edited nor renamed.

## What it does

- The first launch asks for the server (default `https://dozo.ssilistre.dev`, or one click for the
  server on this computer, `http://127.0.0.1:5173`). The choice is saved and can be changed from
  the menu: Dozo, Change Server… (Cmd+,).
- A server that cannot be reached gives a screen with Try again and Change server, not a blank page.
- Standard macOS menus (About, Change Server…, Reload, Quit, and the Edit menu's shortcuts). The
  window comes back at its last size and position.
- Links to other sites open in the default browser. Downloads go to the Downloads folder. File
  inputs open the system file dialog. The session survives a restart: cookies and site storage are
  kept by the system web view.

## What it leaves out

- It does not imitate upstream's desktop bridge, so the web app behaves as it does in a browser:
  no update section, no in-chat search bar, no custom window buttons. Upstream's native features
  (the host computer, Docker management) are not here; updates are the app's own ("Updates").
- Anything that leaves the server's origin opens in the browser. A sign-in that redirects to
  another site therefore finishes in the browser, not in the app; sign in with email and password.
  A link that asks for a new window also opens in the browser, even on the same origin.
- The server address must be the one the pages are served from. An address that redirects to
  another host (a bare domain to `www.`) opens the browser and ends on the "Can't reach" screen.
- Camera, microphone, location and similar requests from a page are denied. Notifications are
  allowed for the server's own origin only (below).
- Links to the browser are limited to one a second, so a page cannot flood it.
- Menus and the local screens are English only.

## Open at Login and Keep Running in Background

Two switches in the Dozo menu, both off until chosen. Each is saved in the same file as the server
address (`server`, in the app's config folder): the address on the first line, then
`open_at_login=` and `keep_running=` lines. A file with the address alone, as older versions
wrote it, still reads, and a missing switch is off. The other way does not: a version from before
these switches cannot read the new file and asks for the server again. The file is written to a
`.tmp` beside it and renamed, so a crash never leaves half an address. They are menu events handled in Rust: no
command was added and `capabilities/local.json` is unchanged.

- Open at Login uses the system's own entry (a macOS launch agent, the Windows `Run` key, a Linux
  XDG autostart file), started with `--from-login`. The entry is the system's: at every launch the
  menu and the file are set to what it says, so one removed from outside shows as off.
- Keep Running in Background off: closing the window quits, as it always did.
- On: closing hides the window on macOS (the Dock icon shows it again). On Windows and Linux it
  hides to a tray icon (Open Dozo, Quit Dozo; a click on Windows shows the window). Where no tray
  icon can be clicked, the window is minimized instead and never hidden. Linux counts a tray as
  there only when something on the desktop hosts tray icons (GNOME needs an extension), and asks
  again at each close.
- A start from the login entry has no window only when the switch is on and the window can be
  brought back (the Dock, or a tray that shows); otherwise the window opens as usual. The window's
  last visible state is never restored, so a hidden exit never makes the next start hidden.
- Quit in the menu ends the app on every system, and so does Quit Dozo in the tray.
- A second launch starts no process: the running app shows its window and brings it forward, hidden
  or minimized (one started by the login entry is ignored). Without a session bus on Linux, a
  second app simply starts.
- The update check and Restart to Update work with the window hidden: once an update is waiting,
  the item is also at the top of the tray's menu. Restarting into an update always opens the
  window, even though the restarted process carries the login entry's argument (a `restarted` file
  beside `server` says so, and is gone once read). The restart releases the single-instance lock
  before it starts the new process (Tauri's `cleanup_before_exit`); this was read in the source,
  not run against a real update.
- Linux needs `libayatana-appindicator3` for the tray: the .deb depends on it, the AppImage carries it.
- macOS and Windows: compiled, not tried by hand. Only Linux runs under `tests/linux_gate.py`.

## Notifications and the unread badge

The web app's own notifications (a bot finished, asks a question or waits for approval, a run
failed) show as system notifications, and the number of unread chats sits on the app icon. The
page still cannot call the app: the system web view shows its notifications, and the count is
read from the page title, where the web app puts it as `(3) Dozo` (only the number; the rule in
`dozo/brand/brand.json` points `Shell.tsx` at `apps/web/src/lib/dozo-desktop-badge.ts`). No
setting, menu item, sound or text was added: the system's own notification settings apply.

- Permission: only for a page whose origin is exactly the chosen server's (scheme, host and port),
  decided by `answer` in `src/alerts.rs` at the moment the page asks, so after Change Server the
  new origin is the one that counts. The web view asks only for the window's own page: WebKitGTK
  and WebView2 refuse a frame from another origin themselves, and WebKitGTK also wants a click or
  key press behind the request (the web app asks when a message is sent). Every other permission
  stays denied.
- Badge: read only from a page on the server's origin, capped at `99+` on the Dock, at `9+` in the Windows taskbar overlay (an ink disc with
  white digits, drawn in `src/alerts.rs`), at 99 in a Linux launcher; cleared at 0, and when the
  window leaves the server (the local screens have no count).
- A click on a notification brings the window back on Linux, hidden or minimized (`reveal_on_click`).

| | Notifications | Click shows the window | Badge |
|---|---|---|---|
| Linux (WebKitGTK) | tried: `tests/linux_gate.py` | tried: `tests/linux_gate.py` | compiled; shows only where the desktop runs a launcher that reads libunity counts (Ubuntu Dock, KDE, Plank); not seen |
| Windows (WebView2) | compiled, not tried | not done: WebView2 shows the notification itself and does not tell the app about a click; the page gets it | compiled, not tried (taskbar overlay) |
| macOS (WKWebView) | not done: WKWebView has no public way to grant a page notifications, so it refuses them; doing it would need private WebKit API or a bridge into the page | not done (nothing to click) | written, not compiled on a Mac yet (`set_badge_label`); built by the release workflow |

Known limits:

- Linux keeps the grant only for the life of the web view's process: after a restart the page
  asks again with the next message sent, and nothing notifies before that.
- Windows keeps the grant in the web view's profile. An origin granted before Change Server keeps
  it there, though it can no longer be the window's page.

## Security

- A page loaded from a server can call nothing in the app. What reaches the app from it is the
  title (read for the unread count only) and the notifications the web view itself shows. The three commands are under Tauri's
  ACL (`build.rs`), and the only capability (`capabilities/local.json`) grants them to the app's
  own screens. It has no `remote` entry and must never get one.
- Only the chosen server's origin and the app's own screens load in the window. Every other web
  address goes to the browser; `file:`, `data:` and unknown schemes are refused (`src/server.rs`).
- `http://` is accepted only for this computer (`localhost`, `127.0.0.0/8`, `::1`). Any other
  address must be `https://`.
- Frames inside the server's page load as they do in a browser (a bot's screen, an embedded page).
  Tauri's navigation hook cannot tell a frame from the window's own page, so `src/frames.rs` puts
  a small delegate in front of the web view's own to make that one distinction. On Linux
  (`src/frames_gtk.rs`) the web view does not say which frame a navigation is for, so a click is
  judged as the window's own page before anything is requested (a link clicked inside a frame
  opens in the browser too), other web navigations go ahead, and the window's own page is
  checked when its answer arrives: a refused page never shows, but its request has been sent.
  Without a click, nothing but a web address can be handed outside the app.
- The local screens are plain HTML, CSS and JavaScript in `ui/`, with a CSP that allows only their
  own files and forbids framing them.

## Build

```sh
dozo/desktop/build.sh         # installs the toolchain if missing, builds, prints the paths
dozo/desktop/build.sh check   # cargo fmt --check, cargo clippy -D warnings, cargo test
```

A macOS app cannot be built in Docker, so this runs on the host (the exception is listed in
`dozo/AGENTS.md`). It needs the Xcode command line tools and installs nothing outside this
directory: rustup, Rust and the Tauri CLI go into `.toolchain/` and the build output into
`target/` (about 4 GB together; both git-ignored). The first run downloads and compiles for several minutes.
Versions are pinned in `rust-toolchain.toml`, `build.sh` (`TAURI_CLI`) and `Cargo.lock`.

Output: `dist/Dozo.app` and `dist/Dozo.dmg`, one universal app for Apple silicon and Intel Macs
(macOS 12 or later). The icon and the logo are generated from
`dozo/brand/assets/` at build time and are not committed here.

`make olc` does not run `check` (it runs in Docker and Rust is on the host): run it by hand after
changing anything in this directory. It checks the macOS code only; the Windows and Linux code is
compiled and tested by the workflows under "Windows" and "Linux".

## Windows

The same app, built on a GitHub Actions Windows runner: nothing here builds it on a Mac. It
compiles and packages there, and the unit tests pass there. Nobody has run the installed app on
Windows yet, so treat everything below as untested until someone does.

- Build: the `dozo-desktop-windows` workflow (`.github/workflows/dozo-desktop-windows.yml`). It
  runs on a pull request that touches this directory, or by hand from the Actions tab (Run
  workflow). It runs clippy and the tests, then `cargo tauri build`.
- Download: the run's `dozo-windows-installer` artifact, a zip holding `Dozo_<version>_x64-setup.exe`
  (an NSIS installer, for the signed-in user, no administrator rights). GitHub keeps artifacts
  for 90 days and asks for a GitHub sign-in to download one.
- Unsigned: Windows SmartScreen warns about an unknown publisher ("More info", then "Run
  anyway"). Handing it out needs a code signing certificate; see `dozo/LAUNCH-CHECKLIST.md`.
- WebView2: the app draws with Microsoft Edge WebView2, which Windows 11 has built in. Where it
  is missing (some Windows 10 installs), the installer downloads Microsoft's bootstrapper and
  installs it, so that computer needs an internet connection during setup.
- Differences from macOS (`tauri.windows.conf.json`, `#[cfg(windows)]` in `src/`): one short
  menu in the window (Change Server… Ctrl+, / Reload Ctrl+R / Quit); the local screens are served
  from `http://tauri.localhost`; `src/frames.rs` is not needed, because the web view asks the
  navigation hook about the window's own page only; links open through the system's URL handler.
  The server address and window position are kept in `%APPDATA%\dev.ssilistre.dozo\`, the web
  view's data in `%LOCALAPPDATA%\dev.ssilistre.dozo\`.
- x64 only.

## Linux

The same app as an AppImage and a .deb for x86_64, built in Docker on any Linux machine and by
the `dozo-desktop-linux` workflow (`.github/workflows/dozo-desktop-linux.yml`, on a pull request
that touches this directory or by hand). Both build on Ubuntu 22.04, so they run on that
release's libraries and newer.

```sh
dozo/desktop/build-linux.sh         # dist/Dozo_<version>_amd64.AppImage and .deb
dozo/desktop/build-linux.sh check   # cargo fmt --check, clippy, cargo test
```

- The AppImage runs where it is (`chmod +x`, then open it). It brings its own libraries except
  the system's GTK and WebKitGTK stack. The .deb installs with `sudo apt install ./Dozo_*.deb`
  and requires `libwebkit2gtk-4.1-0` 2.40 or later; the AppImage needs that too.
- `tests/linux_gate.py` (run by the workflow under a virtual display) checks that a frame from
  another site loads, a clicked link to it opens in the browser without the app requesting it, a
  frame cannot open a mail link on its own, a page sent elsewhere by its script stays, a second
  launch shows the first window, and closing the window ends the app, or with Keep Running in
  Background and no tray keeps it minimized. It also checks that the server's page gets
  notifications and a frame from another origin does not, that one reaches a stand-in for the
  desktop's notification service (`tests/fake_notifications.py`), that a click on it brings the
  window back, and that titles with and without a count leave the app running. Nobody has run the app on a desktop session yet.
- Differences from macOS (`tauri.linux.conf.json`, `#[cfg(target_os = "linux")]` in `src/`): the
  short menu Windows has, inside the window; links open with `xdg-open`; the frame gate above.
  The server address and window position are kept in `~/.config/dev.ssilistre.dozo/`, the web
  view's data in `~/.local/share/dev.ssilistre.dozo/`.
- Unsigned. A Linux package needs no signature to open.

## Signing and distribution

With `~/.config/dozo/sign.conf` in place (`sign.conf.example` lists its two values), `build.sh`
signs the app and the disk image with a Developer ID, has Apple notarize both, staples the tickets
and asks Gatekeeper about each; it fails if any step does, or if the file lacks a value. Such a build opens on any Mac
without a warning. The identity and the notary credentials stay in the keychain of the Mac that
builds: nothing about them is in this repository, and CI does not sign.

- Hardened runtime, secure timestamp.
- Entitlements: none. The app does not use the App Sandbox, and the hardened runtime needs an
  exception only for what a process does itself. This one runs no JIT and loads no unsigned code:
  the system web view compiles JavaScript in its own processes, which carry Apple's entitlements.
  Camera and microphone requests are denied, so there is no device entitlement either.

Without that file the app is signed ad hoc and `build.sh` says so. It then opens without a warning
only on the Mac that built it; a downloaded copy is blocked by Gatekeeper.

## Updates

- At launch and then once a day the app reads
  `https://github.com/SSilistre-dev/dozo/releases/latest/download/latest.json`, downloads a newer
  version in the background and keeps it only if its signature checks out against the public key
  in `tauri.conf.json` and was made for the version the manifest names (`requireSignedVersion`).
- Then one menu appears at the end of the menu bar, "Restart to Update" ("Güncellemek için yeniden
  başlat" on a Turkish system), holding that one item. Nothing installs until it is picked. On
  Windows the installer closes the app and opens the new one; on macOS and Linux the app restarts.
  If the install fails, the update stays waiting and the menu can be picked again.
- A failed check, download, signature or install changes nothing and adds a line to `updates.log`
  (cut to a fresh file past 64 KB, keeping one older file) in the app's log folder (`~/Library/Logs/dev.ssilistre.dozo/`,
  `%LOCALAPPDATA%\dev.ssilistre.dozo\logs\`, `~/.local/share/dev.ssilistre.dozo/logs/`).
- Linux: the AppImage replaces itself, so its folder must be writable; the .deb asks for an
  administrator password through the system's prompt.
- Release: push a `desktop-v<version>` tag on a commit already on `main`, whose version matches
  `tauri.conf.json` and `Cargo.toml`; the workflow stops otherwise. The `dozo-desktop-release`
  workflow builds all three systems in the `desktop-release` environment, signs every update
  package with the updater key (secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`, given only to the steps that sign), writes `latest.json`
  (`latest-json.sh`) and checksums, and leaves a draft release.
- Publish the draft as the repository's latest release (`gh release edit <tag> --draft=false
  --latest`): the apps read `releases/latest`, so if any other release became the latest, every
  app would find no manifest and stop updating until a desktop release is latest again.
- The private key and its password are kept only in those secrets and offline by the owner:
  without them no installed app can be updated again.
- Platform signing in that workflow is optional. With `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY` the Mac app is signed, and with
  `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` also notarized; with `WINDOWS_CERTIFICATE` (a
  base64 .pfx) and `WINDOWS_CERTIFICATE_PASSWORD` the Windows installer is signed. Without them
  the packages are built unsigned (the Mac app ad hoc) and the run still succeeds: an ad-hoc Mac
  disk image is blocked by Gatekeeper when downloaded, so replace it in the draft with one from
  `build.sh` until the Apple secrets are set. Its disk image is not signed itself either way.

## Where it keeps things

- `~/Library/Application Support/dev.ssilistre.dozo/`: the server address, the two switches and the window position.
- `~/Library/WebKit/dev.ssilistre.dozo/` and `~/Library/HTTPStorages/dev.ssilistre.dozo.binarycookies`:
  the web view's site data and cookies.
