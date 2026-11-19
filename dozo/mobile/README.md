# Dozo iOS app

Upstream ships a complete Expo (React Native) app in `apps/mobile`. The Dozo iOS app is that app,
built from the branded staged tree: nothing here is a second app, and `apps/mobile` is never edited
or built in place. This directory holds the build script and the check of its config.

Phase 1, which is all there is so far, stops at the simulator. No Apple account, certificate,
provisioning profile, App Store Connect, TestFlight, real device or cloud build is involved, and
`build.sh` never runs `eas`.

## Build

```
dozo/mobile/build.sh check   # stage, brand, install JS dependencies, check the resolved Expo config
dozo/mobile/build.sh sim     # check, then build for the simulator, install and launch it
dozo/mobile/build.sh clean   # delete the build output and the simulator; the toolchain stays
```

Exit 0, or 2 on any failure. It runs on the host, the third exception to "Docker only"
(`dozo/AGENTS.md`), because Docker cannot build an iOS app. What it needs from the host and never
installs: Xcode with an iOS simulator runtime, Docker (staging and branding still run in it), and a
Ruby 3.3 or newer for CocoaPods (macOS ships 2.6; the one Homebrew carries for itself is found, or
set `DOZO_MOBILE_RUBY`).

Everything else goes into two git-ignored directories:

- `.toolchain/`: Node and pnpm in the versions upstream builds with (`apps/mobile/eas.json`, the
  root `packageManager`), CocoaPods, and the npm, pnpm, gem and CocoaPods caches. `HOME` points
  into it while the tools run, so nothing is written to `~/.npm`, `~/.cache`, `~/.cocoapods`,
  `~/.expo`, a shell profile, Homebrew or a global npm or gem directory.
- `.build/`: a staged tree of this build's own (`DOZO_STAGE_DIR`; the Docker stack's `dozo/.stage`
  is not touched), its `node_modules`, the generated Xcode project and Pods, and Xcode's
  DerivedData (`-derivedDataPath`). A build takes several GB: the script stops below 15 GB free.

`sim` creates a simulator of its own named "Dozo build" and uses only that one. Take a screenshot
with `xcrun simctl io <udid> screenshot shot.png` (the script prints the id); the Simulator window
is not needed. Xcode and the simulator service keep their own state under `~/Library` (the device,
logs); `clean` deletes the device.

Variables: `DOZO_MOBILE_API_URL` is the server the app opens with (default
`https://dozo.ssilistre.dev`; the sign-in screen can still name another). `DOZO_MOBILE_DEVICE` is
the simulator device type (default `iPhone 17`).

There is no CI job: an iOS build needs a macOS runner.

## What makes it Dozo

All of it is in `dozo/brand/brand.json`, applied to the staged tree (`dozo/brand/README.md`):

- the name, the permission texts and every other shown text (the blanket rule), the icon, splash
  and widget pictures (`assets`);
- the id family, defined once as one literal: `dev.ssilistre.dozo` for the app, `.widgets`,
  `.expo-sharing-extension` and `.notifications` for its extensions, `group.dev.ssilistre.dozo`
  for the app group. The owner has not confirmed it;
- no Expo owner, no EAS project id, no update URL: three anchored rules in `app.json`.

On a server with registration closed the app opens on sign-in and offers no sign-up, as the web
app does (`dozo/AGENTS.md`, "Closed registration").

The server address is not a rule: upstream reads `EXPO_PUBLIC_API_URL` at build time, and
`build.sh` sets it.

Checks: the leak gate covers the staged `apps/mobile`; `make olc` brands upstream's `app.json` in a
scratch tree and runs `check-config.mjs` on it; `build.sh check` runs the same check on the config
Expo resolves, which is what the Xcode project is generated from.

## What is off in a Dozo build

Each is upstream's own behaviour for a build without the piece, not new code.

- Push notifications: without an EAS project id the app asks for no Expo push token and registers
  none with the server. Incoming-call pushes: the app still hands its call token to the server it
  is signed in to, and that server sends with the Dozo bundle id as the topic, but only once it has
  an APNs key of the owner's team (`dozo/deploy/README.md`, Mobile app ids). Until then no call
  push arrives.
- Over-the-air updates: off. A new version is a new build.
- Passkeys: the app asks for the server's domain as an associated domain. The server's association
  files carry the Dozo ids, and exist only once the deployment sets the Apple team id and the
  Android signing fingerprint (`dozo/deploy/README.md`, Mobile app ids); until then iOS offers no
  passkey. Password sign-in works.
- Crash reports: the app reports only where the server it is signed in to tells it to; nothing is
  uploaded at build time.
- The App Store update prompt: it looks the bundle id up in the store and finds nothing.
- Sharing into the app, the widget, Siri actions and Live Activities are built but were not
  exercised: phase 1 only opened the app in the simulator.

Still upstream's on purpose: the `rakazo://` link scheme, which the server trusts as the app's
origin (`dozo/brand/README.md`, Identifiers). An upstream app on the same phone claims it too.
There is no store listing: the app's update fallback opens the landing page, and the privacy and
terms links open the landing site's pages (`dozo/landing/README.md`).

## Connection

What the app does when it cannot talk to its server, beyond upstream's own screens (home: could
not reach the server, session expired with Sign in, server problem; Try again where it helps):

- The Server screen checks an address before saving it: https is assumed, spaces, the path and a
  trailing slash are dropped, the server's auth capabilities must answer within 6 seconds, then its
  health. It says which failed: no answer in time, no answer at all (a wrong name, a server that
  is down and a refused certificate look the same to the app), or not a Dozo server. An address
  that fails is tried once with `www.` added or removed, and the one that answers is saved.
- The live stream reconnects by itself as before. After 20 seconds without any answer from the
  server, one line above the chats says so until a request or the reconnect gets through.

`baglanti-testi.sh <url>` makes the requests the app makes, in order, against a server and prints
a pass/fail table: capabilities, the CORS preflight of the live stream, sign-up and sign-in with
a bearer token, the session, the live stream for 60 seconds, and the association files. It signs
up a throwaway account and deletes it at the end; on a server with sign-up closed it skips the
account steps. Exit 0, 2 on any failure. It needs `curl` and `jq`.

## Phase 2

Needs the owner (`dozo/LAUNCH-CHECKLIST.md`, "iOS app"): the lasting bundle id, an Apple Developer
team with the app, its three extensions and the app group registered, signing and a TestFlight
group, the store listing, and a decision on push: it needs an Expo project and APNs key of ours. The server's push topic
and association files already use the Dozo id.
