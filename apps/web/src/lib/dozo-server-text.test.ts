import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { COMPUTER_ALLOWANCE_USED_ERROR } from "@rakazo/contracts";
import { MODEL_REQUIRED_SEND_ERROR } from "@rakazo/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import {
  knownServerText,
  NO_COMPUTER_HOURS,
  planLimitCopy,
  SERVER_SENTENCES,
  SIGN_IN_LABELS,
  serverErrorText,
  signInLabelText,
} from "@rakazo/i18n/run-error";
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

it("says the key refusal in Turkish where onboarding would only say the model was not saved", () => {
  const rejected = "Your model provider rejected the API key. Check your connection settings.";
  expect(serverErrorText(refused(rejected), rejected, "Model kaydedilemedi")).toBe(
    "Model sağlayıcınız API anahtarını reddetti. Bağlantı ayarlarınızı kontrol edin.",
  );
});

it("says a server-sent sign-in label in the UI's language and leaves other labels alone", () => {
  expect(signInLabelText("Sign in with ChatGPT")).toBe("ChatGPT ile giriş yap");
  const untranslated = [...SIGN_IN_LABELS].filter((label) => signInLabelText(label) === label);
  expect(untranslated).toEqual([]);
  expect(signInLabelText("Sign in with Something")).toBe("Sign in with Something");
  expect(signInLabelText(undefined)).toBeUndefined();
  i18n.activate("en");
  expect(signInLabelText("Sign in with ChatGPT")).toBe("Sign in with ChatGPT");
});
