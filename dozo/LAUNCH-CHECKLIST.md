# Launch checklist

What the owner must decide or supply before going public. This is the one list of owner actions and
placeholders. "Blocks launch" means do not open to the public without it. "Can follow" means it can
ship after.

To find every placeholder and upstream image name still in the branded tree, run the leak gate with
`--launch` on a stage (`dozo/brand/README.md`, CLI). It is not part of any gate and fails until the
placeholders are replaced.

- [ ] **Domain** (blocks launch). Replace the `dozo.example` placeholders in `dozo/brand/brand.json`
      (`urls`) with the real domain, including the app and docs subdomains. This also covers the
      links `/discord`, `/get/ios` and `/get/android`.
- [ ] **Hosted pre-release** (blocks opening it to anyone but the owner). The stack runs closed on
      the owner's host (`dozo/deploy/README.md`). Tried there: the owner's account and sign-in, a bot
      computer's screen, control and isolation, the live stream across restarts, a daily backup with
      a restore check, the health check and the response headers. Still open, all the owner's:
  - Docker address pools on the host: other projects hold all of them, so a bot computer starts
    only while one is free (`dozo/deploy/README.md`, Bot computers on a shared host).
  - A copy of the backups off the host, and somewhere for the health check to report to.
  - A model connection: nothing that needs a model has been tried there (chat, bot runs, routines).
  - A rehearsal of a host restart and of a full restore.
  - The CDN's injected analytics script, which the app's CSP blocks on every page: turn it off for
    this address.
- [ ] **Before sign-up opens** (blocks `SIGNUPS_ENABLED=true`). Set `RAKAZO_ADMIN_EMAILS` to the
      owner's verified address and open `/admin` on the host (`dozo/deploy/README.md`, Admin page):
      the account list, one suspend and restore of a test account, and one Stop of a running
      computer have not been tried there. Mail must work first: without a provider nobody can
      verify an address or reset a password.
- [ ] **GitHub owner and repo** (blocks launch). Replace `github.com/OWNER/dozo` in
      `dozo/brand/brand.json` and in the fork notice in `README.md`.
- [ ] **Publish and enable CI** (blocks launch; what is published so far: `dozo/README.md`, Status
      and known limits). Disable upstream's workflows before the first push, create `upstream-main`
      on origin, set the secret `DOZO_SYNC_TOKEN` and the required status check: `dozo/SYNC.md`.
- [ ] **Logo, remaining parts** (blocks launch for desktop and mobile only). The logo is approved and
      applied to the web icons, and to the desktop and mobile icons, splash, widget and Icon Composer
      layer (`dozo/brand/README.md`, Logo; the files were checked as images, not yet on a device or in
      a packaged build). Still open: look at them in a real macOS build (Xcode 26 compiles the bundle),
      an Android launcher with themed icons and the iOS widget; and whether the in-app bot avatars should
      be redrawn from the approved mark. Do not reuse upstream's logo or mascot.
- [ ] **Welcome-mail hero image** (can follow). Made and wired: `dozo/brand/assets/mail/welcome.png`,
      served by the web app at `/email/welcome.png` and linked under the domain you set in `urls`. Open:
      the domain must reach the web app (otherwise host the file there), and a look at the real mail in
      a light and a dark client.
- [ ] **Privacy policy and terms pages** (blocks launch). Upstream links to its own privacy page from
      `packages/contracts/src/ai-consent.ts` (`AI_PRIVACY_URL`), and also to a terms page. Publish our own
      pages and point the rules in `dozo/brand/brand.json` at them before any user signs up.
- [ ] **Our own docs** (blocks launch). Bots fetch upstream docs at `rakazo.com/docs/*`, mainly from
      `packages/adapters/src/builtin-skills.prompt.ts`, plus `packages/core/src/user-error.ts`. Until
      our docs exist, bots answer from upstream's. Host these pages (as `.md`, and the HTML index) and
      map the base URL in `dozo/brand/brand.json`:
  - `docs.md`, `docs/`
  - `account.md`, `approvals.md`, `bot-secrets.md`, `bots-and-chats.md`
  - `build-a-plugin.md`, `build-a-plugin/`
  - `computer.md`, `desktop-app.md`, `fleet-management.md`, `groups.md`
  - `import-an-agent.md`, `integrations.md`, `memory.md`, `messaging-apps.md`
  - `mobile-app.md`, `models.md`, `routines.md`, `skills.md`, `spaces.md`
  - `self-host.md`, `self-host-configuration.md`, `voice-and-calls.md`
  - `troubleshooting/#mcp-oauth-redirect-mismatch`
- [ ] **Support and contact email** (blocks launch). Supply the address and set it in
      `dozo/brand/brand.json`. Done for the repository, without an address: security reports go
      through GitHub private vulnerability reporting (`.github/SECURITY.md`), questions and bugs
      through GitHub issues (`.github/ISSUE_TEMPLATE/`). The root `SECURITY.md` and `CONTRIBUTING.md`
      stay upstream's and still show upstream's addresses to anyone who opens them.
- [ ] **Image registry** (blocks launch for published images). Choose the registry and image names,
      publish the server and computer images, then replace `PUBLISHED_IMAGE_REPO` and the
      `ghcr.io/elie222/rakazo` image names (allowed in the gate until then; `--launch` fails on them).
      Until then disable self-update.
- [ ] **Trademark check for "Dozo"** (blocks launch; not done). Search the relevant registries and
      markets before public use. If it fails, the name lives in `dozo/brand/brand.json`, so a rename
      is a rule change.
- [ ] **Billing, OAuth and listing names** (blocks launch if the feature is on). Create our Stripe
      products, prices and names (upstream billing code is `apps/api/src/billing.ts`; use env
      configuration, never code edits). Set our names in OAuth consent screens, the Slack, Discord and
      Telegram apps and the OpenRouter listing. Owner's decision: the product is open source and a
      hosted SaaS that runs on our servers; payment is not connected yet, so the landing page holds
      a placeholder for the hosted plan (`dozo/landing/README.md`).
- [ ] **Android build name** (blocks launch if the Android build is offered). Publish the APK as
      `dozo.apk` under the release tag the download URL names.
- [ ] **Third-party catalog branding** (decision). The xAI/Grok plugin catalog and import text name
      other vendors, not Rakazo. Decide whether to keep them.
- [ ] **Desktop and mobile apps** (can follow). Store listings, bundle ids (`com.rakazo.app` is
      upstream's) and signing are out of phase 1. The `apps/desktop` and `apps/mobile` release
      workflows must stay disabled until then. The fork's own macOS app (`dozo/desktop/`) is a
      universal build. `dozo/desktop/build.sh` signs it with a Developer ID and has it notarized,
      but only on a Mac that holds the owner's settings file (`dozo/desktop/README.md`, Signing and
      distribution): CI does not sign. Its bundle id (`dev.ssilistre.dozo`) was chosen without the
      owner; changing it later loses each user's saved server and session. Its Windows installer
      (the `dozo-desktop-windows` workflow) is unsigned and has not been run on Windows: handing it
      out needs a first run on a real Windows computer and a code signing certificate (SmartScreen
      warns without one).
- [ ] **Marketing site** (can follow). `apps/www` is out of phase 1 scope. A static page is in
      `dozo/landing/`, published pre-release behind `noindex` (`dozo/deploy/README.md`, "Landing page").
      At launch: remove `robots.txt`, the `noindex` meta and header, swap the
      pre-release addresses for the real domain (`dozo/landing/README.md`).
- [ ] **Community links** (can follow). Upstream's Discord and App Store badges stay in upstream's
      README text. Decide whether to keep them below our fork notice.
