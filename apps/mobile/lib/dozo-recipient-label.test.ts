import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { messages as de } from "@rakazo/i18n/locales/de/messages.po";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { beforeEach, expect, it } from "vitest";

// Runs on the branded tree (`make qa`): the brand rules give the e-mail draft card's recipient
// label its own catalog entry and add the Turkish copy. The test stand-in for the macro ignores a
// context, so the ids are built as the real macro builds them. The message is left out, as the
// production web build strips it, so only the catalog can answer.

beforeEach(() => {
  i18n.load("tr", tr as Messages);
  i18n.activate("tr");
});

it("reads the draft card's recipient as Kime while a date range's end stays Bitiş", () => {
  expect(i18n._({ id: generateMessageId("To", "recipient") })).toBe("Kime");
  expect(i18n._({ id: generateMessageId("To") })).toBe("Bitiş");
});

it("shows the language's own recipient word, not the message id, in another language", () => {
  i18n.load("de", de as Messages);
  i18n.activate("de");
  expect(i18n._({ id: generateMessageId("To", "recipient") })).toBe("An");
});
