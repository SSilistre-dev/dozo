# Dozo mobile app

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
`https://app.dozo.bot`; the sign-in screen can still name another). `DOZO_MOBILE_DEVICE` is
the simulator device type (default `iPhone 17`).

There is no CI job: an iOS build needs a macOS runner.

## Android

The `dozo-mobile-android` workflow builds the Android app from the branded tree on a GitHub runner
(nothing Android is installed on a maintainer's machine). It runs on pull requests that touch
`dozo/mobile/`, a mobile `dozo-*` file or the workflow, and by hand.

- The APK (artifact `dozo-android-apk`) is for phones (arm64-v8a) and the emulator (x86_64), with
  the same server and relay defaults as `build.sh`. It is a release build signed with the debug key
  of the generated project: it installs outside a store ("install unknown apps"), but no store
  takes it, and an APK signed with another key cannot update it in place.
- On an Android 14 emulator, `android/e2e.sh` installs that APK and `android/pair-e2e.mts` plays the
  computer: the real API with one account and a bot, a dev relay, and the relay agent's command
  line as the desktop app runs it. The relay's port is reversed into the emulator (`adb reverse`),
  so the offer's loopback address is the same on both ends. The steps, each with a screenshot in
  the artifact `dozo-android-e2e` (with the device log and the run log): the app opens; `adb shell
  am start` opens the `dozo://pair#…` link, as the camera would; the app asks "Connect to this
  computer?", naming the test relay, and Connect is tapped (Maestro, `android/flows/`); the app
  shows the approval code, which must be the one the agent reports; `approve` on the computer; the
  app signs in and lists the bot; a `dozo://dozo-access-tokens` link then opens a settings page,
  the access tokens, whose "New token" row shows. Last line: `ANDROID PAIRING E2E: PASS|FAIL`.

What a release needs from the owner (none of it is in the repository):

- The lasting application id: `dev.ssilistre.dozo` was chosen without the owner, and a store app
  can never change it.
- A release keystore: the upload key for Google Play (Play App Signing keeps the app key), or one
  key for APKs offered outside the store. Kept as CI secrets (the keystore, its password, the key
  alias and password); the build then needs a signing config for the release variant, which the
  generated project does not have.
- `PASSKEY_ANDROID_CERT_SHA256` on the server, the SHA-256 of the key the installed app is signed
  with (`dozo/deploy/README.md`): passkeys and verified links need it.
- A Play Console developer account, the app created there, and its listing (privacy policy, data
  safety answers, content rating, screenshots).
- Push notifications: a Firebase project with the app registered (`GOOGLE_SERVICES_JSON`) and an
  Expo project of ours, as on iOS; without them the app registers for no push.
- A `versionCode` higher than the last one for every build a store or an installed APK should take.

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
origin (`dozo/brand/README.md`, Identifiers). An upstream app on the same phone claims it too, so
the app also registers `dozo://`, which pairing links use.
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

## Your computer over the relay

The app can use the user's own computer as its server, through the relay (`dozo/relay/PROTOCOL.md`).
The computer shows a QR code holding `dozo://pair#<offer>`, which the phone's camera opens in
the app; the Server screen's "Connect to your computer" opens the same screen, where the code can be
pasted. The app needs no camera permission of its own.

- The screen acts only on that exact link (and on `rakazo://dozo-pair#<offer>`, which desktop
  0.3.0 writes), once per link, and checks the offer before it asks
  anything. It then asks once ("Connect to this computer?"). The question names the relay when it
  is not this build's own (`DOZO_MOBILE_RELAY_URL`, default `https://relay.dozo.bot`, which
  `build.sh` passes as `EXPO_PUBLIC_DOZO_RELAY_URL`), and it names the server the user would be
  signed out of.
- Pairing (`apps/mobile/lib/dozo-relay-connection.ts`) opens one session with the offer's secret and
  sends `/rpc/health`. That first request completes the pairing on the computer and proves a Dozo
  server answers. The computer then becomes the app's server under an address of its own,
  `https://<random id>.computer.dozo.invalid`. No network resolves it, and the name is not the
  channel id. The keys are stored (`RelayAppPairingSchema`, checked when read back) only once the
  server switch succeeded; a failed switch keeps the earlier pairing.
- `apps/mobile/lib/dozo-relay-fetch.ts`, imported first by the root layout, puts the relay in front
  of `fetch` for that address. A computer's name with a port, a user or plain http fails there and
  never reaches DNS. Every JavaScript request and the live stream go through the relay; the socket
  opens on the first request. A computer that is off fails after 8 seconds, like any server that
  does not answer. A redirect is followed only on the computer; one that leaves it fails.
- A request refused on its own (too many open, a head too large) leaves the session in use. A
  session that ended is dropped, and the next request reconnects.
- When the computer removed the phone, the stored pairing goes, if it is that computer's, and
  sign-in offers to pair again.
- Sign-in with a computer as the server shows no password form: a code someone else showed could
  have paired the phone with their computer, and a password typed then would go to them. Instead,
  the phone asks the computer for its sign-in when the screen shows and when the app comes back to
  the front (`apps/mobile/lib/dozo-relay-sign-in.ts`). While the computer waits for the user to
  approve the phone there, the screen shows the same six-digit code the computer shows. The computer
  gives one session per pairing, after that approval (`dozo/relay/agent/README.md`, Phone sign-in).
  Otherwise the screen says why: sign in on the computer, more than one account there, not approved
  in time, or pair again.
- Crypto: `@noble/curves` 2.4.0, `@noble/ciphers` 2.3.0, `@noble/hashes` 2.3.0, and `expo-crypto`
  58.0.8's `getRandomValues` for the system's random bytes. React Native has neither `crypto.subtle`
  nor `crypto.getRandomValues`. Its `getRandomBytes` is not used, because it falls back to
  `Math.random` under a development debugger. The packages come from `dozo/deps/mobile.json`.
  Ciphers and hashes are at the versions upstream already locks, because 2.4.0 would make pnpm move
  upstream's copies. The imported subpaths come to about 43 KB minified (16 KB gzipped).

What does not cross the relay, because the system loads it rather than JavaScript:

- Android's background notification service. It stays off for a computer, and turning it on says
  why.
- A computer's live screen, which loads in a web view. The screen shows its usual cannot-reach line.
- Images and videos the native views load from the server's address (avatars, inline images,
  video). They do not load; each asks DNS for the random `.invalid` name, which carries nothing
  about the channel.
- Sign-in through the system browser and passkeys. They need the server's real address.
- Push notifications and incoming-call pushes need the server's push credentials, which a local
  server does not have, with or without the relay.
- A multipart upload or a file read as a `Blob` is refused with a clear error, and so is a React
  Native `Request` whose body only its own fetch can read. The app's attachments travel inside JSON
  and are not affected.

On the Android emulator (`dozo-mobile-android`, above), the release build pairs end to end: the
`dozo://pair#…` link with its fragment reaches the pairing screen through expo-router, React
Native's socket opens with the upgrade header, and the request held for approval, the session and
the live stream work through the relay. A pairing that fails logs its cause to the device log
behind the screen's generic message.

Not tried yet:

- the link from a real camera (the test opens it with `adb`), and anything on iOS beyond opening
  the simulator;
- a real phone, a real relay over https, and a refused upgrade's status text;
- going to the background and back.

## Phase 2

Needs the owner (`dozo/LAUNCH-CHECKLIST.md`, "iOS app"): the lasting bundle id, an Apple Developer
team with the app, its three extensions and the app group registered, signing and a TestFlight
group, the store listing, and a decision on push: it needs an Expo project and APNs key of ours. The server's push topic
and association files already use the Dozo id.
