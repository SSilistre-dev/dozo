# Data inventory for the App Store privacy labels and Play Data safety

Derived from the code of `apps/mobile` and the server paths it calls, not from the privacy page.
The owner enters the answers in App Store Connect and Play Console; every TODO is a fact only the
owner knows (how the hosted server is configured, what the operator does with the data).

Terms. "The server" is the Dozo server the user signs in to: the hosted one, one they run, or their
own computer through the relay. The app itself sends data to no one else and ships no analytics or
advertising SDK (`apps/mobile/package.json`). "Third parties" below are what the server passes data
on to.

## Collected by the app and sent to the server

| Data | Collected | Linked to the user | Purpose | Third parties | Where in code |
| --- | --- | --- | --- | --- | --- |
| Email address, name | Yes, at sign-up and sign-in | Yes | Account, app functionality | The sign-in provider (Google, Apple) when the user chooses it and the server offers it. TODO owner: which the hosted server enables | `app/sign-in.tsx`, `lib/api-auth.ts` |
| Password | Sent over TLS to the server when signing in or up; not stored on the device. The session token is kept in the system's secure storage | Yes | Authentication | None | `lib/api-auth.ts`, `lib/api.ts` (`SecureStore`), `lib/session.ts` |
| Messages to bots, bot replies, memory, routines | Yes | Yes | App functionality | The model provider the user (or the operator) connected: the server forwards message text and attachments to it. TODO owner: which provider the hosted plans use | `app/thread.tsx`, `app/group-thread.tsx`, `app/routines.tsx`, server `apps/api` |
| Photos and files the user attaches | Yes, only what is picked or shared in | Yes | App functionality | Same as messages | `expo-image-picker`, `expo-document-picker`, `lib/incoming-share.ts` |
| Camera photos | Yes, only when the user takes one to attach | Yes | App functionality | Same as messages | `expo-image-picker` (permission text in `app.json`, branded) |
| Voice during a call, dictated speech | Calls: audio goes to the server. Dictation: the system's speech recognition turns speech into text on the device or at the platform vendor (the app does not ask for on-device only), and the text is sent as a message | Yes | App functionality | The platform's speech service (Apple, Google) for dictation. TODO owner: confirm for the privacy label | `lib/call-session.ts`, `lib/dictation.ts`, `lib/composer-dictation.ts`, `expo-speech-recognition` |
| Push token (Expo) | Only when the build has an Expo project id; the Dozo build has none, so none is registered | Yes, if registered | Notifications | Expo's push service, if ever enabled | `lib/push.ts` (`registerPushToken` returns without a project id) |
| Call token (VoIP or Expo), random installation id | Yes, when the system allows notifications or calls | Yes | Incoming-call alerts | Apple's push service (APNs) carries the call alert; the id is a random value kept in secure storage, not an advertising id | `lib/push.ts` (`registerCallPushToken`, `rakazo.call-device`), `lib/incoming-calls.ts` |
| Crash reports and diagnostics | Only when the server's `/api/monitoring/config` returns a DSN; otherwise nothing is sent. Reports carry a hashed user id and no IP address, request bodies or extra data | Pseudonymous id, when the server sends one | Diagnostics | The error-reporting service the server names (nothing at build time). TODO owner: whether the hosted server sets it | `lib/monitoring.ts`, `packages/logging/src/monitoring.ts` |
| Purchase status | The app reads the plan from the server. The App Store build offers no checkout (`lib/dozo-store-build.ts`); other builds open the server's own billing page in a browser session, so card data never reaches the app | Yes | App functionality | The payment processor, on its own page (not from the App Store build) | `lib/billing.ts` (`openBillingPage`) |
| Reports | Only when the person sends one: the message's id and chat id and what they write, mailed to the operator's feedback address | Yes | App functionality (moderation) | The operator's mail provider | `lib/dozo-message-actions.ts`, `app/(settings)/dozo-feedback.tsx` |
| Blocked people | The ids of people blocked from a message's menu, on the device only | No, device only | App functionality | None | `lib/dozo-blocked-people.ts` |
| Server address, relay pairing keys | Yes, stored on the device only (and the relay carries encrypted traffic when the user's own computer is the server) | No, device only | App functionality | The relay operator sees encrypted traffic only | `lib/api-server.ts`, `lib/dozo-relay-connection.ts` |

## Not collected (no code path, no library, no permission string)

- Contacts, calendar, health, location (precise or coarse), motion, Bluetooth, files outside what
  the user picks, clipboard reads (the clipboard is only written to).
- Advertising id, tracking, cross-app or cross-site tracking: no `NSUserTrackingUsageDescription`,
  no ad or attribution SDK. The App Tracking Transparency prompt is not needed.
- Usage analytics inside the app: none. TODO owner: the server can record product events when
  `ANALYTICS_PROVIDER` is set (`dozo/LAUNCH-CHECKLIST.md`, legal pages); if it is, add "Product
  interaction" as collected, linked, for analytics.
- Local network: the app declares a local-network permission (`NSLocalNetworkUsageDescription`) so
  it can reach a server on the user's LAN; it scans nothing and sends no discovery data.

## Practices to state

- Encrypted in transit: yes with the hosted server (HTTPS), and relay traffic is sealed end to end
  between phone and computer (`dozo/relay/PROTOCOL.md`). A self-hosted server on a local network
  may be plain HTTP: iOS allows that only for local networking (`NSAllowsLocalNetworking`), Android
  allows cleartext traffic for such servers (`apps/mobile/plugins/with-lan-cleartext.js`). TODO
  owner: decide whether to answer the Play "encrypted in transit" question "yes" for the hosted
  service only.
- Deletion: the user can delete the account in the app (`review-checklist.md`). TODO owner: what
  the server removes, how fast, and what it keeps (billing records) so the Play "data deletion"
  answers and the privacy page agree.
- Data shared with third parties for their own purposes: none by the app. TODO owner: whether the
  hosted operator shares anything beyond the processors above.

## Reading this for each store

- App Store: "Data Linked to You" holds Contact Info (email, name), User Content (messages, photos,
  audio), Identifiers (user id, device id for calls), Purchases (status), and Diagnostics when the
  server enables crash reports. "Data Used to Track You": none.
- Play Data safety: the same categories as "collected", all "required" for app functionality except
  diagnostics and dictation (optional); "shared": messages and attachments go to the model provider
  (declare it as shared with a service provider if Play's wording requires it).
