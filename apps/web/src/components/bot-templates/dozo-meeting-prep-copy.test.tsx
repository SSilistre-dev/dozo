// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Messages } from "@lingui/core";
import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { findBotTemplate } from "@rakazo/core";
import { messages as tr } from "@rakazo/i18n/locales/tr/messages.po";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import type { BotTemplateCopy } from "./bot-template-copy";
import { useBotTemplateCopy } from "./bot-template-copy";

// Runs on the branded tree: anchored rules add the template's copy and its Turkish catalog entries.

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

beforeEach(() => {
  i18n.load("en", {});
  i18n.load("tr", tr as Messages);
  i18n.activate("en");
});
afterEach(() => i18n.activate("en"));

function copyIn(locale: string): BotTemplateCopy {
  i18n.activate(locale);
  const template = findBotTemplate("meeting-prep")!;
  let copy: BotTemplateCopy | undefined;
  function Probe() {
    copy = useBotTemplateCopy()(template);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  act(() =>
    root.render(
      <I18nProvider i18n={i18n}>
        <Probe />
      </I18nProvider>,
    ),
  );
  act(() => root.unmount());
  return copy!;
}

it("shows the server's English in English", () => {
  const { name, summary, sample } = findBotTemplate("meeting-prep")!;
  expect(copyIn("en")).toEqual({ name, summary, sample });
});

it("speaks Turkish with the catalog the build ships", () => {
  const copy = copyIn("tr");
  expect(copy.name).toBe("Toplantı hazırlığı");
  expect(copy.summary).not.toBe(findBotTemplate("meeting-prep")!.summary);
  expect(copy.sample).not.toBe(findBotTemplate("meeting-prep")!.sample);
});

it("carries the same strings as the mobile copy", () => {
  const strings = (url: URL) =>
    [...readFileSync(fileURLToPath(url), "utf8").matchAll(/t`([^`]*)`/g)].map((match) => match[1]);
  const web = strings(new URL("./dozo-meeting-prep-copy.ts", import.meta.url));
  const mobile = strings(
    new URL("../../../../mobile/lib/dozo-meeting-prep-copy.ts", import.meta.url),
  );
  expect(web).toHaveLength(3);
  expect(mobile).toEqual(web);
});
