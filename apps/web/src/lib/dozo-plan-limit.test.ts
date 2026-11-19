import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { expect, it } from "vitest";
import { billingErrorText } from "./dozo-plan-limit";

// Runs on the branded tree (`make qa`): the table is exported once the brand rules are applied.

it("a refused checkout of the free plan says why, in the UI's language", () => {
  i18n.loadAndActivate({ locale: "en", messages: {} });
  expect(billingErrorText({ code: "plan_not_offered" }, "Could not open billing")).toBe(
    "This plan is free. Choose a paid plan to upgrade.",
  );
  i18n.loadAndActivate({ locale: "tr", messages: tr as Messages });
  expect(billingErrorText({ code: "plan_not_offered" }, "x")).toBe(
    "Bu plan ücretsiz. Yükseltmek için ücretli bir plan seçin.",
  );
});

it("any other failure keeps the page's own text", () => {
  expect(billingErrorText(new Error("boom"), "Could not open billing")).toBe(
    "Could not open billing",
  );
});
