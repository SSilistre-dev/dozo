# Dozo for macOS and Windows

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
  (the host computer, Docker management, automatic updates) are not here.
- Anything that leaves the server's origin opens in the browser. A sign-in that redirects to
  another site therefore finishes in the browser, not in the app; sign in with email and password.
  A link that asks for a new window also opens in the browser, even on the same origin.
- The server address must be the one the pages are served from. An address that redirects to
  another host (a bare domain to `www.`) opens the browser and ends on the "Can't reach" screen.
- Camera, microphone and similar requests from a page are denied.
- Links to the browser are limited to one a second, so a page cannot flood it.
- Closing the window quits the app. Menus and the local screens are English only.
- One architecture: the build is for the Mac it runs on (no universal binary).

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
  a small delegate in front of the web view's own to make that one distinction.
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

Output: `dist/Dozo.app` and `dist/Dozo.dmg`. The icon and the logo are generated from
`dozo/brand/assets/` at build time and are not committed here.

`make olc` does not run `check` (it runs in Docker and Rust is on the host): run it by hand after
changing anything in this directory. It checks the macOS code only; the Windows code is compiled
and tested by the workflow under "Windows".

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

## Signing and distribution

The app is signed ad hoc (no Apple Developer identity). It opens without a warning on the Mac
that built it, because a locally built app is not quarantined. It is not ready to hand out: on
another Mac a downloaded copy is blocked by Gatekeeper (`spctl --assess` rejects it). Distribution
needs a Developer ID certificate and notarization; see `dozo/LAUNCH-CHECKLIST.md`.

## Where it keeps things

- `~/Library/Application Support/dev.ssilistre.dozo/`: the server address and the window position.
- `~/Library/WebKit/dev.ssilistre.dozo/` and `~/Library/HTTPStorages/dev.ssilistre.dozo.binarycookies`:
  the web view's site data and cookies.
