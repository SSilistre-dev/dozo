# Export compliance and France

Not legal advice: a summary of what the code does and what the owner decided, for whoever changes
either. Check with an adviser before relying on it.

## Decision (first submission)

`ITSAppUsesNonExemptEncryption` stays `false` (upstream's `ios.config.usesNonExemptEncryption` in
`apps/mobile/app.json`), and the app is not offered in France on the App Store.

## Why France is left out

The app encrypts in its own code, not only through the system: pairing a phone with the user's
own computer seals the relay traffic with AES-256-GCM, X25519 and HKDF from `@noble/ciphers` and
`@noble/curves` (`apps/mobile/lib/dozo-relay-crypto.ts`, `dozo/relay/PROTOCOL.md`). France asks
for a declaration to its cyber-security agency (ANSSI) before software with such encryption is
distributed there, and App Store Connect asks for that declaration when France is among the
storefronts. Leaving France out avoids filing it for the first release.

## Before adding France

One of:

- File the ANSSI declaration for the app's encryption, set `usesNonExemptEncryption` to `true`
  (an anchored rule on `app.json`), answer App Store Connect's questions (standard algorithms in
  addition to the system's, France included) and upload the declaration; or
- Move the pairing encryption to the operating system's own library (Apple CryptoKit on iOS,
  through a native module), so the app no longer ships encryption of its own, then confirm the
  exempt answer still holds.

Either way, also re-check the `false` value above: it states that the app uses only exempt
encryption, which is the owner's call, recorded in `review-checklist.md` (Export compliance).
