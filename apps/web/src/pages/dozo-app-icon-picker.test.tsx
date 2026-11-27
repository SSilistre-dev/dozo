// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AppIconPicker } from "./dozo-app-icon-picker";

it("renders no picker even where the desktop app can change its icon", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("rakazoDesktop", { appIcon: { get: vi.fn(), set: vi.fn() } });
  const container = document.createElement("div");
  const root = createRoot(container);
  await act(async () => root.render(<AppIconPicker />));
  expect(container.innerHTML).toBe("");
  await act(async () => root.unmount());
});

afterEach(() => vi.unstubAllGlobals());

it("is the picker account settings imports (branded tree)", () => {
  const overlay = readFileSync(
    fileURLToPath(new URL("./settings/AccountSettingsOverlay.tsx", import.meta.url)),
    "utf8",
  );
  expect(overlay).toContain('import { AppIconPicker } from "./dozo-app-icon-picker"');
});
