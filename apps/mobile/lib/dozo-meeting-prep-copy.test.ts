import { findBotTemplate } from "@rakazo/core";
import { afterEach, expect, it } from "vitest";
import { botTemplateCopy } from "./bot-template-copy";
import { resetI18nForTests } from "./i18n";

// Runs on the branded tree: anchored rules add the template's copy and its Turkish catalog entries.

afterEach(() => resetI18nForTests());

const template = () => findBotTemplate("meeting-prep")!;

it("shows the server's English in English", () => {
  resetI18nForTests("en");
  const { name, summary, sample } = template();
  expect(botTemplateCopy(template())).toEqual({ name, summary, sample });
});

it("speaks Turkish with the catalog the build ships", () => {
  resetI18nForTests("tr");
  const copy = botTemplateCopy(template());
  expect(copy.name).toBe("Toplantı hazırlığı");
  expect(copy.summary).not.toBe(template().summary);
  expect(copy.sample).not.toBe(template().sample);
});
