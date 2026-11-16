# Launch checklist

What the owner must decide or supply before going public. "Blocks launch" means do not open to the
public without it. "Can follow" means it can ship after.

- [ ] **Domain** (blocks launch). Replace the `dozo.example` placeholders in `dozo/brand/brand.json`
      with the real domain, including app and docs subdomains.
- [ ] **GitHub owner and repo** (blocks launch). Replace `github.com/OWNER/dozo` in
      `dozo/brand/brand.json` and in the fork notice in `README.md`.
- [ ] **Final logo** (blocks launch). Supply the logo assets. Wire them through `dozo/brand/brand.json`
      and `dozo/theme/`. Do not reuse upstream's logo or mascot.
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
- [ ] **Support and contact email** (blocks launch). Supply the address. Set it in
      `dozo/brand/brand.json`, and in `SECURITY.md` terms if we need our own disclosure contact
      (`SECURITY.md` is an upstream file, so handle it via a build-time rule).
- [ ] **Disable upstream GitHub workflows** (blocks launch). Many publish, deploy and release using
      upstream's secrets and targets (`.github/workflows/`). Disable them in our repo as described in
      `dozo/SYNC.md`. Do not edit them.
- [ ] **Image registry** (blocks launch for published images). Choose the registry and image names
      for published images. Set them in `dozo/docker/` and in the compose files you ship.
- [ ] **Trademark check for "Dozo"** (blocks launch; not done). Search the relevant registries and
      markets before public use. If it fails, the name lives in `dozo/brand/brand.json`, so a rename
      is a rule change.
- [ ] **Billing and Stripe product names** (blocks launch if billing is on). Create our Stripe
      products, prices and names. Upstream billing code is `apps/api/src/billing.ts`. Use env
      configuration, never code edits.
- [ ] **Desktop and mobile apps** (can follow). Store listings, bundle ids and signing are out of
      phase 1. The `apps/desktop` and `apps/mobile` release workflows must stay disabled until then.
- [ ] **Marketing site** (can follow). `apps/www` is out of phase 1 scope.
- [ ] **Community links** (can follow). Upstream's Discord and App Store badges stay in upstream's
      README text. Decide whether to keep them below our fork notice.
