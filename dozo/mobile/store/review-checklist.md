# App Store review and Play policy checklist

What a reviewer will check, what the code does today (with the file), and what the owner must
decide or provide. Nothing here is legal advice; where a rule's reach is unclear it says so.
"OK" means the code does it. "RISK" means a rejection is plausible. "TODO" is the owner's.

## Account deletion (App Store 5.1.1(v), Play account deletion policy)

OK in the app. Settings, profile screen, "Delete account" (`apps/mobile/app/(settings)/profile.tsx`,
`apps/mobile/components/account-deletion.tsx`). It asks the owner to confirm with the password, a
fresh sign-in with the single-sign-on provider, or an emailed code, then calls the server's
`/api/auth/delete-user` (`apps/mobile/lib/api-auth.ts`, `deleteAccount`) and returns to sign-in.
The paywall screen offers the same action. Play also wants a web page for deletion requests, named
in the Data safety form: OK, `https://dozo.bot/delete-account/` (`dozo/landing/delete-account/`, also in Turkish); TODO owner: enter it in the form.
TODO owner: what deletion removes on the server and what is kept (billing records), for the
privacy page and `privacy.md`.

## Paid plans and the external purchase (App Store 3.1.1, Play payments policy)

OK in the App Store build. `dozo/mobile/build.sh archive` always bundles with
`EXPO_PUBLIC_DOZO_STORE_BUILD=1` (`DOZO_MOBILE_STORE_BUILD=1 build.sh sim` shows it on the simulator),
read once in `apps/mobile/lib/dozo-store-build.ts`. That build sells nothing and links to no
payment page:

- no Billing row in Settings, no paywall for an organization without a plan, no past-due line
  with "Manage billing", no invite gift (a free month on a paid plan); a link to Billing or the
  paywall lands on the chats (`components/dozo-store-gate.tsx`);
- a limit (no computer on Free, hours used up, shared space full) is named without Upgrade, without
  "ask the owner to upgrade" and without "change the plan" (alerts, the chat's failed run, the
  computer screen, the Own computer switch); deleting files stays the way out of a full space;
- a plan bought on the web still works in the app; the app only stops offering one.
- a run that failed for want of credits or a plan says "Connect a model in Settings before running
  bots." instead of pointing at Billing (`storeRunErrorDetails`, on the run-error sheet).
- no Wallet row either: connecting the wallet bots spend from opens the payment provider's page
  outside the app, which a reviewer may read as an external payment path. Spending limit stays: it
  only caps the user's own model spend and buys nothing.

Decision: client-side, not by the server hiding `billing` per client: the server cannot tell a
store binary from a sideloaded or self-built one, and the store rule is about the binary.
Not covered: what a bot writes, and a paid tool's "Add credits in Billing" result a bot may repeat. A Free run is never told to suggest an upgrade
(`packages/adapters/src/dozo-no-computer.prompt.ts`); a paid plan out of hours may say "get more
computer hours" or "update the payment" in prose, with no link. An organization without any plan
(rare: a new one starts on Free) sees its runs fail with the server's reason and no way to buy.
Play: the Android build is not a store build yet; the same flag applies when it is.

## Sign in with Apple (App Store 4.8)

OK in the App Store build: a third-party sign-in (Google) shows only when the server also offers
Sign in with Apple; organization sign-in (OIDC, exempt) and email stay
(`storeSignInProviders`, an anchored rule on `apps/mobile/app/sign-in.tsx`). TODO owner: to keep
Google in the store app, enable Apple on the hosted server (`APPLE_CLIENT_ID`,
`packages/auth/src/social.ts`) and the capability on the App ID. Without it, someone who only ever
signed in with Google cannot sign in on iPhone (an emailed code or a password set on the web still
works). Linking Google to an existing account from the profile screen is unchanged.
Measured on the hosted server (2026-11-21): its capabilities list no third-party sign-in providers,
so the store app shows email only and 4.8 does not apply.

## Permission purpose strings

OK. In `apps/mobile/app.json` through anchored rules, branded Dozo texts, held by
`dozo/mobile/check-config.mjs`: camera and photo library (attach images), photo library add (the
share sheet's Save Image), microphone (calls and dictation, the same text from all three plugins
that write it), speech recognition (calls and dictation), local network (a server on the user's
network), and for the phone tools in Settings > Phone: calendar (read and add events), reminders
(read and add, iPhone only), contacts and location while in use, each asked only when its switch is turned on;
no background location. No Bluetooth, tracking or Face ID use in the app's code, so `expo-secure-store` is told to write no Face ID string (`faceIDPermission: false`); `build.sh`
fails if the generated plist still has one. Background modes `voip`, `audio` and
`remote-notification`: App Review expects incoming calls to use CallKit (the app's native call
module reports them, `lib/incoming-calls.ts`) and background audio to be a call in progress. Say
so in the review notes. Capabilities the App ID needs (registered by the archive step unless Apple
refuses one): push, time-sensitive and communication notifications, associated domains (passkeys),
app groups, Siri. TODO owner: check each appears on the identifier after the first archive.

Privacy manifest: `ios.privacyManifests` declares UserDefaults (CA92.1, the app's own Swift
modules), file timestamps (C617.1, 0A2A.1, 3B52.1), boot time (35F9.1) and disk space (E174.1,
85F4.1) for React Native; `build.sh` fails when the generated `PrivacyInfo.xcprivacy` lacks them.

Status bar: `UIViewControllerBasedStatusBarAppearance` is false, so the bar takes the style the
app sets from its theme (`apps/mobile/app/_layout.tsx`); it read dark on the dark sign-in screen.

## Export compliance (encryption)

Decided by the owner: the value stays `false` and France is left out of the first release (`export-compliance.md`; what adding France needs is there).
`apps/mobile/app.json` (upstream's `ios.config.usesNonExemptEncryption: false`, written to the plist
as `ITSAppUsesNonExemptEncryption` NO) answers "no encryption beyond the exempt kind", so App Store
Connect asks nothing. The app does use encryption in its own code beyond HTTPS and the system's:
the relay seals phone-to-computer traffic with AES-256-GCM, X25519 and HKDF through
`@noble/ciphers` and `@noble/curves` (`dozo/relay/PROTOCOL.md`, `apps/mobile/lib/dozo-relay-crypto.ts`).
Options:

- Keep `false`: no code change. It states the app uses only exempt encryption, which the relay's
  own AES-GCM does not obviously meet; the risk is a false declaration, not a rejection.
- Set `true` (one anchored rule on `app.json`, and `check-config.mjs` to hold it): every upload
  then waits on App Store Connect's questions. The expected answers: standard algorithms, in
  addition to the system's; mass-market (exempt under Category 5 Part 2); then whether the app is
  offered in France, which needs the French encryption declaration. Once Apple issues an export
  compliance code, `ITSEncryptionExportComplianceCode` in the plist skips the question per build.
- Leave France out of the storefronts to avoid the declaration.

Google Play has no equivalent question.

## User-generated and AI content

OK, with limits. Guideline 1.2 and Play's AI-generated-content policy:

- Report: a message's menu (long press) has Report on a bot's reply and on another member's message
  in a shared chat, while the server takes feedback. It opens the feedback form starting with
  "Reported message <id> in chat <id>"; the person adds why and sends it to the operator's address
  (`apps/mobile/lib/dozo-message-actions.ts`, `app/(settings)/dozo-feedback.tsx`). TODO owner: the
  hosted server must have a feedback address (and mail) set, or Report does not show; review the
  reports within 24 hours.
- Block: another member's message has Block, which asks first and then hides that person's
  messages in every shared chat on this phone (`apps/mobile/lib/dozo-blocked-people.ts`). Kept on
  the device only: not synced, not undone in the app, the person is not told and stays in the Space.
  A chat they wrote in shows no preview line in the inbox (the preview does not say who wrote it);
  push notifications from them still arrive. Removing a member stays the Space owner's
  (`app/space-members.tsx`).
- People join a Space only by invitation; say so in the review notes.

## Age rating and content declarations

TODO owner. Answer from the real behaviour: an unrestricted AI chat where bots can browse the web
and act on the user's behalf, with user-controlled models. Expect an age rating that reflects
"unrestricted web access" and AI-generated content (the App Store questionnaire asks about both).
Play: content rating questionnaire, target audience (not for children), the Data safety form from
`privacy.md`, the ads declaration ("no ads"), and the financial-features and news declarations
("no").

## Privacy policy URL

Ready: https://dozo.bot/privacy/ (`dozo/landing/privacy/`, the same page the app's links open).
TODO owner: the lawyer's review noted in `dozo/LAUNCH-CHECKLIST.md`, and a support URL.

## Demo account for review

TODO owner, required. Reviewers cannot create a useful account on a closed-preview server. Provide in
App Store Connect's review notes and Play Console's app access: an account on the hosted server
that is ready to use (a bot with a working model connection and, if a paid plan is reviewed, that
plan), its email and password, and the server address if it is not the default
(https://app.dozo.bot). Keep a model connection and credit on it that outlast the review. Say that
connecting a computer over the relay needs a desktop app and need not be tested. Use a throwaway
account, never a real person's data.

## Other points a reviewer may raise

- Placeholder or unfinished features: the widget, share extension, Siri actions and Live Activities
  are built but were not exercised in phase 1 (`dozo/mobile/README.md`); test them on a device
  before submitting, or the review will.
- Not affiliated: the listing and review notes must not suggest any link to the project Dozo is
  forked from.
