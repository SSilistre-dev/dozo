import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { COMPUTER_ALLOWANCE_USED_ERROR } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { planLimitCopy } from "@rakazo/i18n/dozo-plan-limits";
import {
  knownServerText,
  NO_COMPUTER_HOURS,
  SERVER_SENTENCES,
  serverErrorText,
} from "@rakazo/i18n/dozo-server-text";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

// Runs on the branded tree only: the Turkish lines are in the fork's catalog block.

/** A refusal as the RPC client throws it: the server's sentence and an HTTP status. */
const refused = (message: string, status = 400) => Object.assign(new Error(message), { status });

beforeEach(() => {
  i18n.load({ en: {}, tr: tr as Messages });
  i18n.activate("tr");
});

it("says a refusal people often see in the UI's language, keyed by the server's sentence", () => {
  expect(knownServerText(refused("Space not found", 404))).toBe("Alan bulunamadı");
  expect(knownServerText(" Computer is busy ")).toBe("Bilgisayar meşgul");
  expect(knownServerText(refused(MODEL_REQUIRED_SEND_ERROR))).toBe(
    "Bir koşu başlatmak için bir model bağlayın.",
  );
  expect(knownServerText(refused("Something new"))).toBeNull();
  expect(knownServerText({ message: 42 })).toBeNull();
  i18n.activate("en");
  expect(knownServerText("Admins only")).toBe("Admins only");
});

afterEach(() => {
  vi.restoreAllMocks();
});

it("says the English before any language is active, never throwing", () => {
  vi.spyOn(i18n, "locale", "get").mockReturnValue("");
  expect(knownServerText("Admins only")).toBe("Admins only");
  expect(planLimitCopy().upgradeTo("Premium")).toBe("Upgrade to Premium");
  expect(planLimitCopy().upgrade).toBe("Upgrade");
});

it("has a Turkish line for every sentence it knows", () => {
  const untranslated = [...SERVER_SENTENCES].filter(
    (sentence) => knownServerText(sentence) === sentence,
  );
  expect(untranslated).toEqual([]);
});

it("puts other server English behind the caller's copy, only where the UI is not English", () => {
  expect(serverErrorText(refused("Webhook key not found", 404), "Webhook key not found", "x")).toBe(
    "x",
  );
  expect(serverErrorText(refused("Stop the bot first"), "Stop the bot first", "x")).toBe(
    "Önce botu durdurun",
  );
  // Copy the client chose, and text that is not the server's own message, pass.
  expect(serverErrorText(refused("boom"), "Bağlanamadı", "x")).toBe("Bağlanamadı");
  expect(serverErrorText(new Error("Local"), "Local", "x")).toBe("Local");
  i18n.activate("en");
  expect(serverErrorText(refused("Webhook key not found", 404), "Webhook key not found", "x")).toBe(
    "Webhook key not found",
  );
});

it("leaves the two refusals screens recognise and word themselves", () => {
  expect(NO_COMPUTER_HOURS).toBe(COMPUTER_ALLOWANCE_USED_ERROR);
  const hours = refused(COMPUTER_ALLOWANCE_USED_ERROR, 403);
  expect(serverErrorText(hours, COMPUTER_ALLOWANCE_USED_ERROR, "x")).toBe(
    COMPUTER_ALLOWANCE_USED_ERROR,
  );
  const model = refused(MODEL_REQUIRED_SEND_ERROR);
  expect(serverErrorText(model, MODEL_REQUIRED_SEND_ERROR, "x")).toBe(MODEL_REQUIRED_SEND_ERROR);
});
