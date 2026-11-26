# Dozo mobile app

Upstream ships a complete Expo (React Native) app in `apps/mobile`. The Dozo iOS app is that app,
built from the branded staged tree: nothing here is a second app, and `apps/mobile` is never edited
or built in place. This directory holds the build script and the check of its config.

The simulator build needs no Apple account, certificate, provisioning profile, App Store Connect,
real device or cloud build. The release steps (`archive`, `upload`, and the Android `release` job)
need the owner's accounts and keys and do nothing without them. `build.sh` never runs `eas`.
Release: below. Store texts and review notes: `store/`.

## Build

```
dozo/mobile/build.sh check   # stage, brand, install JS dependencies, check the resolved Expo config
dozo/mobile/build.sh sim     # check, then build for the simulator, install and launch it
dozo/mobile/build.sh archive # Mac, with the Apple secrets below: a signed Release archive and .ipa
dozo/mobile/build.sh upload  # Mac, with the same: upload that .ipa to TestFlight
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

The App Store build: `archive` always bundles with `EXPO_PUBLIC_DOZO_STORE_BUILD=1`, which sells
nothing in the app (no Billing, paywall, price or payment link) and shows Google sign-in only beside
Sign in with Apple (`apps/mobile/lib/dozo-store-build.ts`, `store/review-checklist.md`).
`DOZO_MOBILE_STORE_BUILD=1 dozo/mobile/build.sh sim` shows that build on the simulator. `archive`
also writes the build number into the app's and each extension's `Info.plist`, and fails when the
archive's differ.

Signing: `archive` runs with `HOME` in `.toolchain/home`, so it links
`.toolchain/home/Library/Keychains` to the user's own `~/Library/Keychains` (a link, nothing is
copied); without it codesign stops with "A default keychain could not be found".

One-time setup in the Apple Developer portal before the first archive, for the app id
`dev.ssilistre.dozo` (Xcode registers the ids through the API key, the last two need the portal):

- extension ids `dev.ssilistre.dozo.notifications`, `dev.ssilistre.dozo.widgets` and
  `dev.ssilistre.dozo.expo-sharing-extension`;
- the App Group `group.dev.ssilistre.dozo`, assigned to the app and to the sharing extension;
- Communication Notifications on `dev.ssilistre.dozo.notifications`.

There is no CI job: an iOS build needs a macOS runner.

## Android

The `dozo-mobile-android` workflow builds the Android app from the branded tree on a GitHub runner
(nothing Android is installed on a maintainer's machine). Its test job runs on pull requests that
touch `dozo/mobile/`, a mobile `dozo-*` file or the workflow, and by hand; the store-signed build
is its `release` job (`## Release`).

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
- The emulator runs the plain Android image, without Google's apps: on the Google image the
  launcher, still busy after boot, showed "Pixel Launcher isn't responding" over the app. `e2e.sh`
  starts only once the system has finished starting (boot completed, the package manager answers,
  the boot broadcasts are delivered). On a failure the artifact also holds the window list and
  the run log names any system dialog that covered the app; each start of the app logs how long
  its first screen took.

What a release needs from the owner: "What the owner must do", below.

## Release

Nothing a release needs is in the repository: the secrets below are the owner's, and without them
each step prints that it was skipped and exits 0 (iOS) or is skipped by the workflow (Android).

### Android (GitHub Actions)

The `release` job of `dozo-mobile-android` runs on a tag `mobile-v*` (any suffix) or by hand
(Actions, run workflow), never on a pull request. It builds a release-signed APK (for installing
outside a store) and an AAB (for Google Play) and keeps them in the artifact `dozo-android-release`
for 30 days. A tag also runs the emulator job next to it; the release does not wait for it.

```
git tag mobile-v1.0.14 && git push origin mobile-v1.0.14
```

- Secrets (repository secrets): `DOZO_ANDROID_KEYSTORE_BASE64` (the keystore file, base64: `base64 -i
  release.keystore | pbcopy`), `DOZO_ANDROID_KEYSTORE_PASSWORD`, `DOZO_ANDROID_KEY_ALIAS`,
  `DOZO_ANDROID_KEY_PASSWORD`. If any of the four is empty a small `signing` job says so and the
  `release` job is skipped, not failed.
- Signing: the generated Gradle project signs its release variant with a debug key.
  `android/release-gradle.mjs` patches that generated `app/build.gradle` (never a file in the
  repository): a `release` signing config that reads the keystore, its passwords and the alias from
  environment variables when Gradle runs, so nothing secret is written into the project, and the
  version. It stops with exit 2 if the generated file no longer looks as expected, so a build never
  falls back to the debug key unnoticed. The workflow then checks the APK is not signed by a debug
  key and prints its certificate's SHA-256, which is what `PASSKEY_ANDROID_CERT_SHA256` takes for an
  APK installed outside the store. The keystore is decoded into a private temporary file and
  deleted at the end of the job.
- Why a patch and not Gradle's `android.injected.signing.*` properties: those are an undocumented
  internal of the Android Gradle plugin and may stop working with it, while the patch fails loudly
  when the template changes. Why not an Expo config plugin: it would need an anchor in upstream's
  `app.json` and would change every build, including the debug-key one that CI tests.
- Version: `versionName` is the app's `version` in the Expo config (upstream's `app.json`);
  `versionCode` is the workflow run number plus the repository variable
  `DOZO_ANDROID_VERSION_CODE_BASE` (default 0). Play and an installed APK take only a higher code:
  set the variable once, above the last code used, and every later run is higher. Re-running a run
  keeps its number; start a new run. The file name carries both: `dozo-android-<name>-<code>.apk`.
- The AAB holds arm64-v8a and x86_64, like the APK: 32-bit ARM phones are not served.
- The first Play upload is made by hand in the Play Console (an app must exist there before any API
  takes a bundle); Play App Signing keeps the app key and this keystore is the upload key.

### iOS (a Mac)

```
DOZO_ASC_KEY_ID=... DOZO_ASC_ISSUER_ID=... DOZO_ASC_KEY_P8=/path/AuthKey_XXXX.p8 \
DOZO_APPLE_TEAM_ID=... dozo/mobile/build.sh archive
(same variables)      dozo/mobile/build.sh upload
```

- `archive` runs the same stage, brand, config check and prebuild as `sim`, then `xcodebuild
  archive` (Release, generic iOS device, automatic signing for the team) and `xcodebuild
  -exportArchive` with the method `app-store-connect`. Xcode creates and renews the certificate and
  profiles itself through the API key (`-allowProvisioningUpdates`), so the key needs the Admin or
  App Manager role. The .ipa lands in `.build/ipa`.
- `upload` sends that .ipa with `xcrun altool --upload-app` and the same key; TestFlight lists the
  build a few minutes after Apple has processed it. Only Xcode's own tools are used.
- Variables: `DOZO_ASC_KEY_ID` (10 characters), `DOZO_ASC_ISSUER_ID` (a UUID),
  `DOZO_ASC_KEY_P8` (the .p8 file's path, or its base64 text), `DOZO_APPLE_TEAM_ID` (10 characters),
  and `DOZO_IOS_BUILD_NUMBER` (optional; every upload needs a higher one than the last; the default
  is the UTC time as `yymmddHHMM`). The version shown is the Expo config's `version`.
- With any of the four secrets unset, both steps print `skipped: not set: <names>` and exit 0.
  A set but malformed value exits 2. Nothing but the names is printed.
- The key is copied for the run into a private directory under `.build` (where `altool` looks for
  `private_keys/AuthKey_<id>.p8`) and removed when the script exits, however it ends. It is never
  written to the repository or a log.
- Unverified: the steps need a Mac with Xcode and the owner's account, so only the skip and
  validation logic ran (`check-config.test.mjs`) and the script passes `bash -n` and shellcheck.
  The first real archive may need adjusting (a capability Apple has to approve, `altool`'s current
  flags in the Xcode in use).

## What the owner must do

One list; each item is something only the owner's accounts or decisions can do.

Accounts
- Apple Developer Program membership, an App Store Connect app record for the bundle id, a
  TestFlight group.
- A Google Play Console developer account and the app created there.
- A Firebase project with the Android app registered, and an Expo project of ours, only if push
  notifications are wanted (`GOOGLE_SERVICES_JSON`; the Dozo build has neither, so it registers no
  push token). Calls need the server's own APNs key (`dozo/deploy/README.md`, Mobile app ids).

Decisions
- The lasting application id and bundle id. `dev.ssilistre.dozo` was chosen without the owner and a
  store app can never change it; it is one line in `dozo/brand/brand.json` and `check-config.mjs`
  holds the build to it.
- How paid plans are sold from the mobile apps (`store/review-checklist.md`, the first risk).
- The export-compliance answer (`ios.config.usesNonExemptEncryption`), whether to add a report
  action for user content, the age rating and content declarations, and which sign-in providers the
  hosted server offers (Sign in with Apple when Google is offered): all in `store/review-checklist.md`.
- The version: `version` comes from upstream's `app.json` (1.0.x as upstream bumps it). A Dozo
  version of its own would need an anchored rule.

Keys and secrets
- Android, repository secrets: `DOZO_ANDROID_KEYSTORE_BASE64`, `DOZO_ANDROID_KEYSTORE_PASSWORD`,
  `DOZO_ANDROID_KEY_ALIAS`, `DOZO_ANDROID_KEY_PASSWORD`; repository variable
  `DOZO_ANDROID_VERSION_CODE_BASE` (above the last versionCode used). Generate the keystore once,
  keep an offline copy: losing the upload key means a Play support request.
- iOS, in the shell of the Mac that archives: `DOZO_ASC_KEY_ID`, `DOZO_ASC_ISSUER_ID`,
  `DOZO_ASC_KEY_P8`, `DOZO_APPLE_TEAM_ID` (an App Store Connect API key with the App Manager or
  Admin role).
- On the server: `PASSKEY_APPLE_APP_IDS=<team id>.dev.ssilistre.dozo` and
  `PASSKEY_ANDROID_CERT_SHA256` (the digest the release job prints; for a Play install, Play's app
  signing key digest from the Play Console instead), and the `APNS_VOIP_*` values for calls
  (`dozo/deploy/README.md`).

Store listing
- Edit and enter `store/listing.en.md` and `store/listing.tr.md`; make the screenshots and the
  Android feature graphic; a support URL; the category.
- Answer the privacy forms from `store/privacy.md` (resolve its TODOs); a web page for account
  deletion requests (Play); the lawyer's review of the privacy and terms pages.
- A demo account for review with a working model connection (`store/review-checklist.md`).

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
The App Store listing is https://apps.apple.com/app/dozo-bot/id6837702832: the update fallback, the
review prompt and Settings' rating row use it on iOS. Android has no Play listing, so it gets no
review prompt or rating row and its update fallback opens the landing page. The privacy and terms
links open the landing site's pages (`dozo/landing/README.md`).

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
  sign-in offers to pair again. A phone connected at that moment drops at once, its live stream
  included: the relay closes its socket with the code for a deleted channel (`4001`), which needs
  no further request.
- While the relay says the computer is not connected, the line above the chats says "Your computer
  is offline. Reconnecting…" as soon as a request has failed, instead of waiting 20 seconds as for
  a server that does not answer. It goes when the computer connects again.
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
- A picture or video the app would give a native view as a URL on the server's address. The app
  has none today: bot avatars and link icons arrive inside the data, and attachments, previews and
  video are fetched through the RPC and shown from a local cache file, all of which cross the
  relay. A native view asked for such a URL would ask DNS for the random `.invalid` name, which
  carries nothing about the channel. Add a relay-aware loader only when a screen needs one.
- Sign-in through the system browser and passkeys. They need the server's real address.
- Push notifications and incoming-call pushes need the server's push credentials, which a local
  server does not have, with or without the relay.
- A multipart upload or a file read as a `Blob` is refused with a clear error, and so is a React
  Native `Request` whose body only its own fetch can read. The app's attachments travel inside JSON
  and are not affected.

The chat's core flow over the relay is tested with the phone's own connection and `fetch`, a relay
on a loopback port and the computer's agent, in front of a stand-in for the local server's chat
requests (`apps/mobile/lib/dozo-relay-core-flow.test.ts`): reading the chats, sending a message
with a 10 MiB attachment, the live stream's signals (one on every reconnect, then one per change),
a relay restart, the computer going off and back, removal, two phones, a replayed record, and that
the relay saw no plaintext and keeps no key. It is not the real API: the real server is reached
over the relay in the desktop stack e2e and the emulator e2e, which do not send a message.

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

The release steps are above (`## Release`); what is still the owner's is one list, `## What the
owner must do`. `dozo/LAUNCH-CHECKLIST.md`, "iOS app", points here. The server's push topic and
association files already use the Dozo id.
