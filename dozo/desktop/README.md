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
- Let Bots Use This Computer (in the Dozo menu): the person's own bots can run commands on this
  computer instead of a hosted one. See "Bots on this computer" below.
- Links to other sites open in the default browser. Downloads go to the Downloads folder. File
  inputs open the system file dialog. The session survives a restart: cookies and site storage are
  kept by the system web view.

## What it leaves out

- It does not imitate upstream's desktop bridge, so the web app behaves as it does in a browser:
  no update section, no in-chat search bar, no custom window buttons. Upstream's native features
  (running its own server on this computer, Docker management) are not here; updates are the
  app's own ("Updates"). Bots using this computer is the app's own too (below), with a menu item
  rather than a switch in the web app's settings, which only that bridge would show.
- Anything that leaves the server's origin opens in the browser. A sign-in that redirects to
  another site therefore finishes in the browser, not in the app; sign in with email and password.
  A link that asks for a new window also opens in the browser, even on the same origin.
- The server address must be the one the pages are served from. An address that redirects to
  another host (a bare domain to `www.`) opens the browser and ends on the "Can't reach" screen.
- Camera, microphone and similar requests from a page are denied.
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

## Security

- A page loaded from a server can call nothing in the app. The three commands are under Tauri's
  ACL (`build.rs`), and the only capability (`capabilities/local.json`) grants them to the app's
  own screens. It has no `remote` entry and must never get one. The dialog plugin's commands are
  granted to no page: only the app's Rust code opens its dialogs.
- Bots reach this computer only after the person allows it in the system dialog, which names the
  server and which no page can answer. The device token is kept in the system keyring, never in
  a file.
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

## Bots on this computer

Turning on Let Bots Use This Computer asks "Allow bots to use this computer?" in a system dialog
with the warning "A bot on <server> can read your files on this computer and run programs as
you." (Turkish on a Turkish system). Allow pairs this computer with the chosen server under the signed-in
account and connects to it; the web app's settings then list it under Computers as Connected.

- Protocol: upstream's paired computer, unchanged, so the server needs nothing new. The app posts
  the web view's sign-in cookie to `/api/devices/pair` (only to the chosen server's origin) and
  keeps the device token it gets back in the system keyring (`src/device_pairing.rs`). It then holds one outbound WebSocket to
  `/api/devices/connect` with that token (`src/device_socket.rs`); the server never connects in.
  Lost connections come back with backoff; a ping every 30 seconds notices a silent drop.
- What a bot can do (`src/device_run.rs`): run commands and, through them, work with files.
  Commands arrive as an argument list and start without a shell in between (the server's own
  shell tool sends `<shell> -lc <command>`, as upstream does). They run as this user, in the
  bot's own folder or anywhere in the home folder; any other working folder is refused. They get
  only the usual shell variables of this app's environment, stop at their timeout, and each one
  leads its own process group. Screen control is not offered: a bot asking to use an app on
  screen is told it is not available here.
- What stopping a command reaches: its process group, which a run's cancel, the bot's stop and
  turning access off all signal. On Linux each command also carries its own mark in its
  environment, so what it started in a new session or group (`setsid`, a double fork) is found in
  `/proc` and stopped too, and a group is signalled only while a marked process is still in it.
  What a command hands to another manager is out of reach on every system: `systemd-run --user`,
  launchd, cron, `at`, a login item, or a process that clears its environment and leaves the group.
  On macOS, `setsid` and a double fork escape as well; on Windows, the process tree is stopped only
  while the command itself still runs. A finished command's leftovers are tracked (at most 256)
  and forgotten within a second of ending.
- The server's rules stay upstream's: only chats the person starts with their own bots reach this
  computer, never routines or other people's messages, and the first command in each Space asks
  in the chat first.
- Ends: turning the item off (running commands stop; the token is revoked on the server and
  deleted here; if the server cannot be reached, the app says so, no command reaches this
  computer, and the revoke is retried with backoff, at every launch and before turning it on
  again, which cannot pair until it succeeds); removing the computer in the web app's settings; signing out or a password
  reset (the pairing ends; the same account's next sign-in pairs again on the next page load or
  when the window comes forward, another account is asked again); quitting the app (commands
  stop).
- The answer holds for one server and one account; another server starts switched off. Turning
  on, off, pairing and the server ending it run one at a time; the menu's check mark always shows
  the saved answer.
- Keyring: macOS Keychain, Windows Credential Manager, the Secret Service on Linux (GNOME
  Keyring, KWallet). Without one, the app does not pair and says so, as upstream's app refuses to
  without secure storage; a plain file is never used for the token.
- While connected, the menu's check mark is the only sign in the app; the web app's settings
  show the computer as Connected. No extra indicator (a tray badge or a title): it would be one
  more always-visible element for a state the person turned on themselves. With Keep Running in
  Background, bots can still use this computer while the window is hidden.
- Plans: a paired computer is not a hosted one, so Free's missing computer hours do not affect it.
- Not done yet: screen control (macOS needs the Accessibility and Screen Recording permissions,
  which this app does not ask for). Only the Linux app has been run against a server; the
  Windows code compiles and runs its tests in CI, the macOS code is not built on a pull request.

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
  Background and no tray keeps it minimized. Nobody has run the app on a desktop session yet.
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

- `~/Library/Application Support/dev.ssilistre.dozo/`: the server address, the two switches and the
  window position; under `devices/`, per server, the account this computer is allowed for and
  whether a revoke is pending (Windows and Linux: the config folders named above). The device
  token is in the system keyring under `dev.ssilistre.dozo`. Each bot's own folder is under
  `computers/` in the app's data folder (the same folder on macOS, `~/.local/share/dev.ssilistre.dozo/` on Linux).
- `~/Library/WebKit/dev.ssilistre.dozo/` and `~/Library/HTTPStorages/dev.ssilistre.dozo.binarycookies`:
  the web view's site data and cookies.
