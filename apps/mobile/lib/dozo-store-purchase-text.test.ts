import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Runs on the branded tree. The App Store build sells nothing (App Review 3.1.1), so wording about
// buying a plan, credits or a price may exist in the app's source only where it is shown to
// someone who can buy, or says a fact without pointing at a purchase. Every file that has such
// wording is listed here with the reason; a new file with it fails until it is gated and listed.

const PURCHASE_WORDS =
  /\b(upgrade|subscribe|subscription|billing|credits?|plans?|pric(?:e|ing)|premium|trial|renew|payment|checkout|purchase|invoice|wallet|free months?|paid)\b|\$\d/i;
// Messages, and quoted text with a space (a path or an id such as "billing/status" is not wording).
const STRING = /\b(?:t|msg)`[^`]*`|"[^"\n ]* [^"\n]*"|'[^'\n ]* [^'\n]*'/g;
const SOURCE_DIRS = ["app", "components", "lib"];

type Entry = { file: string; why: string; guard?: { file: string; token: string } };

const GATED_SCREEN = (file: string): Entry => ({
  file,
  why: "a purchase screen: DozoStoreGate lands a link to it on the chats",
  guard: { file, token: "DozoStoreGate" },
});

const ALLOWED: Entry[] = [
  GATED_SCREEN("app/paywall.tsx"),
  GATED_SCREEN("app/(settings)/billing.tsx"),
  GATED_SCREEN("app/(settings)/wallet.tsx"),
  {
    file: "app/(settings)/_layout.tsx",
    why: "titles of the Billing and Wallet screens, which are gated",
    guard: { file: "app/(settings)/billing.tsx", token: "DozoStoreGate" },
  },
  {
    file: "components/dozo-past-due-line.tsx",
    why: "the past-due line and its Manage billing button",
    guard: { file: "components/dozo-past-due-line.tsx", token: "storeBuild" },
  },
  {
    file: "app/computer.tsx",
    why: "the Upgrade button on a computer that ran out of hours",
    guard: { file: "app/computer.tsx", token: "!storeBuild" },
  },
  {
    file: "lib/dozo-size-limit.ts",
    why: "the size alert's Upgrade button",
    guard: { file: "lib/dozo-size-limit.ts", token: "store" },
  },
  {
    file: "lib/cards/run-error-presentation.ts",
    why: "the hours actions Start plan now, Renew plan and Upgrade, dropped by storeComputerHoursOut",
    guard: {
      file: "components/thread/thread-run-error.ts",
      token: "storeComputerHoursOut(computerHoursOutCopy(",
    },
  },
  {
    file: "app/invite.tsx",
    why: "the invite gift, which the store build never remembers",
    guard: { file: "lib/inbox/use-inbox.ts", token: "storeBuild" },
  },
  { file: "app/(settings)/account.tsx", why: "balances only: credits and media left, no purchase" },
  { file: "components/models/model-role-settings.tsx", why: "a model choice's name" },
  { file: "lib/account/spending-limit.ts", why: "the user's own spending cap, which buys nothing" },
  { file: "components/vault/vault-item-editor.tsx", why: "the vault's billing address field" },
  { file: "components/vault/vault-item-sheet.tsx", why: "the vault's billing address field" },
  { file: "app/(settings)/model-connection.tsx", why: "a model provider's own subscription sign-in" },
  { file: "lib/auth/use-subscription-sign-in.ts", why: "a model provider's own subscription sign-in" },
  { file: "lib/bots/bot-template-copy.ts", why: "sample text a template bot writes about" },
];

const root = new URL("..", import.meta.url).pathname;

function sources(dir: string): string[] {
  return readdirSync(join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" ? [] : sources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.|\.test-support\./.test(entry.name) ? [path] : [];
  });
}

function purchaseWording(file: string): string[] {
  const text = readFileSync(join(root, file), "utf8");
  return (text.match(STRING) ?? []).filter((s) => PURCHASE_WORDS.test(s));
}

describe("purchase wording in the mobile source", () => {
  const withWording = SOURCE_DIRS.flatMap(sources)
    .filter((file) => purchaseWording(file).length > 0);

  it("sits only in files listed with a reason", () => {
    const listed = new Set(ALLOWED.map((entry) => entry.file));
    expect(withWording.filter((file) => !listed.has(file))).toEqual([]);
  });

  it("is listed only for a file that still has it", () => {
    expect(ALLOWED.map((entry) => entry.file).filter((file) => !withWording.includes(file))).toEqual(
      [],
    );
  });

  it.each(ALLOWED.filter((entry) => entry.guard))("$file keeps its store gate", ({ guard }) => {
    expect(readFileSync(join(root, guard!.file), "utf8")).toContain(guard!.token);
  });
});
