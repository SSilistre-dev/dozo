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
in the Data safety form: TODO owner (a page on `dozo.bot`; none exists in `dozo/landing/` today).
TODO owner: what deletion removes on the server and what is kept (billing records), for the
privacy page and `privacy.md`.

## Paid plans and the external purchase (App Store 3.1.1, Play payments policy)

RISK, and the biggest one. The app sells nothing through the stores' own billing.

- A Free account that hits a limit gets an alert whose upgrade button opens the web Billing page in
  the system browser (`apps/mobile/lib/dozo-plan-limit.ts`, `openPlanUpgrade`, `webBillingUrl`).
- The in-app Billing and paywall screens (`app/(settings)/billing.tsx`, `app/paywall.tsx`) start a
  subscription or buy credits on the payment processor's checkout page, opened inside the app as a
  browser session (`apps/mobile/lib/billing.ts`, `openBillingPage`). They appear only when the
  server has billing on (`me.billingEnabled`, `app/(settings)/account.tsx`).
- Plans and credits are digital goods used inside the app. Apple's 3.1.1 requires in-app purchase
  for them, with exceptions that depend on the storefront (for example the United States, where a
  link out to the web is allowed, and the EU's own rules). Google Play requires Play Billing for
  digital goods unless an alternative billing programme is joined. The reader-app exception (3.1.3(a))
  covers content bought elsewhere, not a service like this one.
- Options for the owner, none built: (a) ship the iOS and Play builds without a way to buy, with
  billing hidden by the server for those clients, and sell on the web only; (b) add the stores'
  purchase flows (a large piece of work with a server side); (c) keep the links and apply for
  the external-link entitlement or programme where it is allowed, accepting a rejection elsewhere.
  Whichever it is, state it in the review notes. Do not describe the Free plan in the listing as
  "free app with in-app plans" unless the choice matches.

## Sign in with Apple (App Store 4.8)

TODO owner, depends on the hosted server's settings. The app lists the sign-in providers the server
offers (`signInProviders` in `packages/contracts/src/auth.ts`, `apps/mobile/app/sign-in.tsx`) and
shows Apple's native button when "apple" is among them (`apps/mobile/lib/native-provider-button.tsx`,
the `expo-apple-authentication` plugin is in `app.json`). The built-in providers are Google and
Apple, set by `GOOGLE_CLIENT_ID` and `APPLE_CLIENT_ID` (`packages/auth/src/social.ts`,
`apps/api/src/env.ts`). Rule of thumb: if the hosted server offers Google, it must offer Apple too;
with email and password only, 4.8 does not apply. Sign in with Apple needs the capability on the
App ID, which `-allowProvisioningUpdates` normally adds, and the server's Apple client id and key.

## Permission purpose strings

OK. The usage descriptions are in `apps/mobile/app.json` and are branded Dozo texts:
camera and photo library (attach images), microphone and speech recognition (calls and dictation),
local network (reach a server on the user's network). Each names a feature the user started. The
app declares background modes `voip`, `audio` and `remote-notification`: App Review expects incoming
calls to use CallKit (the app's native call module reports them, `lib/incoming-calls.ts`) and
background audio to be a call in progress. Say so in the review notes. Capabilities the App ID
needs (registered automatically by the archive step unless Apple refuses one): push, time-sensitive
and communication notifications, associated domains (passkeys), app groups, Siri.
TODO owner: check each appears on the identifier after the first archive.

## Export compliance (encryption)

TODO owner, decide before the first TestFlight upload. `apps/mobile/app.json` (upstream's value,
`ios.config.usesNonExemptEncryption: false`) answers "no" to App Store Connect's question, so the
upload asks nothing. The app does use encryption beyond HTTPS and the system's own: the relay
seals phone-to-computer traffic with AES-256-GCM, X25519 and HKDF through `@noble/ciphers` and
`@noble/curves` (`dozo/relay/PROTOCOL.md`, `apps/mobile/lib/dozo-relay-connection.ts`). Apple's
questionnaire counts standard algorithms in the app's own code as "yes", with the usual exemption
for mass-market software (a self-classification, an annual report to the US export office and, for
France, a declaration). Flipping the answer is one anchored rule on `app.json`, not made here
because it is the owner's call after checking with their adviser. Google Play has no equivalent
question.

## User-generated and AI content

RISK. Guideline 1.2 and Play's AI-generated-content policy ask for a way to report offensive
content and to block abusive users where the app has user-generated content. The app has shared
Spaces and group threads with invited members (`app/space-members.tsx`, `app/group-thread.tsx`)
and bot replies from a model. There is no report or block action in the mobile code today.
Mitigations that exist: people join a Space only by invitation, and the server owner (the operator)
moderates. Options: add a report action that emails the support address (a code change, not
done here), or explain in the review notes that content is private to invited members and the
operator contact is `TODO owner`. Also: Play's policy wants AI features to show a feedback path;
a support address in the listing covers the minimum.

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
