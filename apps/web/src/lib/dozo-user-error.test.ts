import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { beforeEach, expect, it } from "vitest";
import { errorText } from "./user-error";

// The wiring runs on the branded tree only: brand rules route upstream's errorText through the
// fork's server-refusal copy.

const refused = (message: string, status = 400) => Object.assign(new Error(message), { status });

beforeEach(() => {
  i18n.load({ en: {}, tr: tr as Messages });
  i18n.activate("tr");
});

it("a Turkish UI never shows the server's English", () => {
  expect(errorText(refused("Space not found", 404), "Kaydedilemedi")).toBe("Alan bulunamadı");
  expect(errorText(refused("Webhook key not found", 404), "Kaydedilemedi")).toBe("Kaydedilemedi");
  expect(errorText({ code: "space_limit_reached", message: "Space limit reached" })).toBe(
    "Alan sınırına ulaşıldı. Yenisi için bir alanı silin.",
  );
});

it("an English UI keeps upstream's text", () => {
  i18n.activate("en");
  expect(errorText(refused("Webhook key not found", 404), "Could not save")).toBe(
    "Webhook key not found",
  );
});
