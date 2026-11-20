// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

const lingui = vi.hoisted(() => ({ locale: "en" }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("../lib/i18n", () => ({ getActiveUiLocale: () => lingui.locale }));

import { DozoSignupTerms } from "./dozo-signup-terms";

let root: ReturnType<typeof createRoot>;
let container: HTMLDivElement;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function links(locale: string) {
  lingui.locale = locale;
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  act(() => root.render(<DozoSignupTerms />));
  return [...container.querySelectorAll("a")].map((a) => [
    a.textContent,
    a.getAttribute("href"),
    a.getAttribute("target"),
    a.getAttribute("rel"),
  ]);
}

it("links the terms and the privacy policy in one line", () => {
  expect(links("en")).toEqual([
    ["Terms", "https://dozo.bot/terms/", "_blank", "noopener noreferrer"],
    ["Privacy", "https://dozo.bot/privacy/", "_blank", "noopener noreferrer"],
  ]);
  expect(container.querySelectorAll("p")).toHaveLength(1);
});

it("links the Turkish pages in Turkish", () => {
  expect(links("tr").map(([, href]) => href)).toEqual([
    "https://dozo.bot/tr/terms/",
    "https://dozo.bot/tr/privacy/",
  ]);
});

it("links the English pages in a language the site does not have", () => {
  expect(links("de").map(([, href]) => href)).toEqual([
    "https://dozo.bot/terms/",
    "https://dozo.bot/privacy/",
  ]);
});
