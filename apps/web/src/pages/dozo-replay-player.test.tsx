// @vitest-environment jsdom
import type { ComponentProps } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: ({
    variant: _v,
    size: _s,
    ...props
  }: ComponentProps<"button"> & Record<string, string>) => <button type="button" {...props} />,
  LogoAvatar: () => <svg data-logo />,
}));

import { DozoReplayPlayer } from "./dozo-replay-player";
import { DOZO_SHARE_RENDERERS } from "./dozo-share-renderers";

const TOKEN = "A".repeat(43);
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(payload: unknown) {
  await act(async () => root.render(<DozoReplayPlayer payload={payload} token={TOKEN} />));
}
const control = (label: string) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("steps through the replay, showing each kept screenshot under the link", async () => {
  await render({
    steps: [
      { line: "Browser navigate · shop.example.test", frame: null },
      { line: "Screenshot", frame: 0 },
    ],
  });
  expect(container.textContent).toContain("Browser navigate · shop.example.test");
  expect(container.querySelector("img")).toBeNull();
  expect(control("Previous").disabled).toBe(true);
  await act(async () => control("Next").click());
  expect(container.querySelector("img")?.getAttribute("src")).toBe(
    `/api/v1/dozo/shared/${TOKEN}/frames/0`,
  );
  expect(control("Next").disabled).toBe(true);
  await act(async () => control("Previous").click());
  expect(container.textContent).toContain("shop.example.test");
});

it("draws a step's line as text, never as markup", async () => {
  await render({ steps: [{ line: "<img src=x onerror=alert(1)>", frame: null }] });
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
});

it("shows only the logo for a payload it cannot read", async () => {
  await render({ steps: "nope" });
  expect(container.querySelector("[data-logo]")).not.toBeNull();
  expect(container.querySelector("button")).toBeNull();
});

it("is the page a replay link draws, loaded when one is opened", async () => {
  expect(await DOZO_SHARE_RENDERERS.replay!()).toBe(DozoReplayPlayer);
});
