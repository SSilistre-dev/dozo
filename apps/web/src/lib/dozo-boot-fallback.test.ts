// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeEach, describe, expect, it } from "vitest";

// The branded index.html (the boot shell rule in dozo/brand/brand.json) and the boot script.
const file = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const html = readFileSync(file("../../index.html"), "utf8");
const script = readFileSync(file("../../public/dozo-boot.js"), "utf8");

const style = html.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
const body = (html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? "").replace(
  /<script[\s\S]*?<\/script>/g,
  "",
);
/** The rule that brings the fallback up, and after how many seconds. */
const shown = style.match(/([^{}]+)\{[^}]*animation:dozo-late 0s (\d+)s forwards[^}]*\}/);
const stallMs = Number(script.match(/const STALL_MS = ([\d_]+);/)?.[1]?.replace(/_/g, ""));
const english = (
  new Function(`return ${script.match(/const TEXT = (\{[\s\S]*?\n {2}\});/)?.[1]}`)() as {
    en: [string, string];
  }
).en;

const late = () => document.getElementById("dozo-late")!;
const showing = () => late().matches(shown![1]!.trim());

describe("boot fallback without any script", () => {
  beforeEach(() => {
    document.body.innerHTML = body;
  });

  it("says the server cannot be reached, with a reload of the same page, readable by everyone", () => {
    expect(late().querySelector("p")?.textContent).toBe(english[0]);
    const retry = late().querySelector("a")!;
    expect(retry.textContent).toBe(english[1]);
    expect(retry.getAttribute("href")).toBe("");
    expect(late().closest("[aria-hidden]")).toBeNull();
  });

  it("comes up only after the boot script's own watch had its chance", () => {
    expect(shown, "a rule shows #dozo-late after a delay").not.toBeNull();
    expect(stallMs).toBe(15_000);
    expect(Number(shown![2]) * 1000).toBeGreaterThan(stallMs);
    expect(style).toMatch(/#dozo-late\{display:none\}/);
    expect(style).toMatch(/@keyframes dozo-late\{to\{visibility:visible\}\}/);
    expect(showing()).toBe(true);
  });

  it("stays away once the boot script answered or the app painted", () => {
    document.getElementById("dozo-boot")!.dataset.state = "unreachable";
    expect(showing()).toBe(false);
    document.getElementById("dozo-boot")!.remove();
    expect(showing()).toBe(false);
  });
});
