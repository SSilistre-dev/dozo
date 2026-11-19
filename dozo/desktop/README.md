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
- Camera, microphone and similar requests from a page are denied.
- Links to the browser are limited to one a second, so a page cannot flood it.
- Closing the window quits the app. Menus and the local screens are English only.

## Security

- A page loaded from a server can call nothing in the app. The three commands are under Tauri's
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
  frame cannot open a mail link on its own, and a page sent elsewhere by its script stays. Nobody
  has run the app on a desktop session yet.
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
- A failed check, download, signature or install changes nothing and adds a line to `updates.log`
  in the app's log folder (`~/Library/Logs/dev.ssilistre.dozo/`,
  `%LOCALAPPDATA%\dev.ssilistre.dozo\logs\`, `~/.local/share/dev.ssilistre.dozo/logs/`).
- Linux: the AppImage replaces itself, so its folder must be writable; the .deb asks for an
  administrator password through the system's prompt.
- Release: push a `desktop-v<version>` tag whose version matches `tauri.conf.json` and
  `Cargo.toml`. The `dozo-desktop-release` workflow builds all three systems, signs every update
  package with the updater key (repository secrets `TAURI_SIGNING_PRIVATE_KEY` and
  `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`), writes `latest.json` (`latest-json.sh`) and checksums,
  and leaves a draft release. Publishing the draft ships the update. The private key and its
  password are kept only in those secrets and offline by the owner: without them no installed
  app can be updated again.
- Platform signing in that workflow is optional. With `APPLE_CERTIFICATE`,
  `APPLE_CERTIFICATE_PASSWORD` and `APPLE_SIGNING_IDENTITY` the Mac app is signed, and with
  `APPLE_ID`, `APPLE_PASSWORD` and `APPLE_TEAM_ID` also notarized; with `WINDOWS_CERTIFICATE` (a
  base64 .pfx) and `WINDOWS_CERTIFICATE_PASSWORD` the Windows installer is signed. Without them
  the packages are built unsigned (the Mac app ad hoc) and the run still succeeds: an ad-hoc Mac
  disk image is blocked by Gatekeeper when downloaded, so replace it in the draft with one from
  `build.sh` until the Apple secrets are set. Its disk image is not signed itself either way.

## Where it keeps things

- `~/Library/Application Support/dev.ssilistre.dozo/`: the server address and the window position.
- `~/Library/WebKit/dev.ssilistre.dozo/` and `~/Library/HTTPStorages/dev.ssilistre.dozo.binarycookies`:
  the web view's site data and cookies.
