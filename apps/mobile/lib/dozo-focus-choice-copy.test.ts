import { i18n } from "@lingui/core";
import { generateMessageId } from "@lingui/message-utils/generateMessageId";
import { beforeEach, describe, expect, it } from "vitest";
import { dozoFocusOptionLabel, dozoFocusQuestion } from "./dozo-focus-choice-copy";

const QUESTION = "What do you want me on first?";

describe("the first-run focus card on the phone", () => {
  beforeEach(() => {
    i18n.load("en", {});
    i18n.activate("en");
  });

  it("shows the card in the app language, as the web app does", () => {
    i18n.load("tr", {
      [generateMessageId(QUESTION)]: "İlk olarak neyle ilgilenmemi istiyorsun?",
      [generateMessageId("Day-to-day work")]: "Günlük işler",
      [generateMessageId("Inbox & email")]: "Gelen kutusu ve e-posta",
      [generateMessageId("Research & writing")]: "Araştırma ve yazı",
      [generateMessageId("A bit of everything")]: "Biraz her şey",
    });
    i18n.activate("tr");
    expect(dozoFocusQuestion(QUESTION)).toBe("İlk olarak neyle ilgilenmemi istiyorsun?");
    expect(dozoFocusOptionLabel(QUESTION, "day", "Day-to-day work")).toBe("Günlük işler");
    expect(dozoFocusOptionLabel(QUESTION, "inbox", "Inbox & email")).toBe(
      "Gelen kutusu ve e-posta",
    );
    expect(dozoFocusOptionLabel(QUESTION, "research", "Research & writing")).toBe(
      "Araştırma ve yazı",
    );
    expect(dozoFocusOptionLabel(QUESTION, "everything", "A bit of everything")).toBe(
      "Biraz her şey",
    );
  });

  it("leaves any other card's text as the server wrote it", () => {
    expect(dozoFocusQuestion("Pick one")).toBe("Pick one");
    expect(dozoFocusOptionLabel("Pick one", "day", "Day-to-day work")).toBe("Day-to-day work");
    expect(dozoFocusOptionLabel(QUESTION, "unknown", "Other")).toBe("Other");
  });
});
