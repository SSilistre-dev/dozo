// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEFAULT_APP_ICON } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { AppIconRoute, appIconRead } from "./dozo-app-icon-hidden";

const redirect = vi.hoisted(() => vi.fn());
vi.mock("expo-router", () => ({
  Redirect: (props: { href: string }) => {
    redirect(props.href);
    return null;
  },
}));

it("reports the icon as not switchable and keeps the default", async () => {
  expect(await appIconRead.queryFn()).toEqual({ supported: false, icon: DEFAULT_APP_ICON });
});

it("sends a direct link to the app icon screen back to General", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(<AppIconRoute />));
  expect(redirect).toHaveBeenCalledWith("/general");
  await act(async () => root.unmount());
});

// Runs on the branded tree, where the rules below have applied to upstream's screens.
const source = (path: string) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

it("reads General's app icon row through the hidden read, never the device module", () => {
  const general = source("../app/(settings)/general.tsx");
  expect(general).toContain('from "../../lib/dozo-app-icon-hidden"');
  expect(general).not.toContain('from "../../lib/appearance/app-icon"');
});

it("serves the app icon route from the redirect", () => {
  expect(source("../app/(settings)/app-icon.tsx")).toContain(
    'export { AppIconRoute as default } from "../../lib/dozo-app-icon-hidden"',
  );
});
