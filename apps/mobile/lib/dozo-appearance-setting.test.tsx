// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const device = vi.hoisted(() => ({
  preference: "system" as string,
  set: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityLabel,
  }: {
    children: ReactNode;
    accessibilityLabel?: string;
  }) => <section aria-label={accessibilityLabel}>{children}</section>,
}));
vi.mock("./appearance/appearance", () => ({
  getCachedAppearancePreference: () => device.preference,
  setAppearancePreference: async (preference: string) => {
    device.set(preference);
    device.preference = preference;
  },
}));
vi.mock("./native/native", () => ({ useThemedStyles: () => ({ section: {} }) }));
vi.mock("./settings/settings-page-styles", () => ({ createSettingsPageStyles: () => ({}) }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children, label }: { children: ReactNode; label?: string }) => (
    <section aria-label={label}>{children}</section>
  ),
  SettingsLabel: ({ children }: { children: string }) => <h3>{children}</h3>,
}));
vi.mock("../components/ui/menu-picker", () => ({
  MenuPicker: (props: {
    label: string;
    choices: Array<{ key: string; label: string }>;
    value: string;
    onChange: (key: string) => void;
  }) => (
    <>
      <fieldset aria-label={props.label} data-value={props.value}>
        {props.choices.map((choice) => (
          <button key={choice.key} type="button" onClick={() => props.onChange(choice.key)}>
            {choice.label}
          </button>
        ))}
      </fieldset>
      <button type="button" onClick={() => props.onChange("neon")}>
        A choice no one offered
      </button>
    </>
  ),
}));
vi.mock("../components/native/native-segmented-control", () => ({
  NativeSegmentedControl: (props: {
    accessibilityLabel: string;
    options: Array<{ value: string; label: string }>;
    value: string;
    onChange: (value: string) => void;
  }) => (
    <div role="radiogroup" aria-label={props.accessibilityLabel} data-value={props.value}>
      {props.options.map((option) => (
        <button key={option.value} type="button" onClick={() => props.onChange(option.value)}>
          {option.label}
        </button>
      ))}
    </div>
  ),
}));

import { DozoAppearanceSetting } from "../components/dozo-appearance-setting";
import { getDozoBubble, getDozoTheme } from "./dozo-theme";
import { setDozoTheme } from "./dozo-theme-store";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const picker = () => container.querySelector<HTMLElement>("fieldset");
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label)!;
const labels = (parent: ParentNode) =>
  [...parent.querySelectorAll("button")].map((entry) => entry.textContent);

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  device.preference = "system";
  device.set.mockReset();
  setDozoTheme(null);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(<DozoAppearanceSetting />));
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DozoAppearanceSetting", () => {
  it("offers System, Light, Dark and the six named themes in one menu, then the message color", () => {
    expect(picker()?.getAttribute("aria-label")).toBe("Appearance");
    expect(labels(picker() as HTMLElement)).toEqual([
      "System",
      "Light",
      "Dark",
      "Sumi",
      "Yoru",
      "Hoji",
      "Washi",
      "Matcha",
      "Kasumi",
    ]);
    const colors = container.querySelector<HTMLElement>("[role=radiogroup]");
    expect(colors?.getAttribute("aria-label")).toBe("Message color");
    expect(labels(colors as HTMLElement)).toEqual(["Bot color", "Neutral"]);
    expect(colors?.dataset.value).toBe("bot");
  });

  it("shows the stored choice", () => {
    expect(picker()?.dataset.value).toBe("system");
  });

  it("picking a theme stores its tone as the Light or Dark choice and marks the theme", async () => {
    await act(async () => button("Washi").click());
    expect(device.set).toHaveBeenCalledExactlyOnceWith("light");
    expect(getDozoTheme()?.id).toBe("washi");
    expect(picker()?.dataset.value).toBe("washi");
  });

  it("picking System, Light or Dark clears the theme", async () => {
    await act(async () => button("Sumi").click());
    expect(picker()?.dataset.value).toBe("sumi");
    await act(async () => button("Light").click());
    expect(device.set).toHaveBeenLastCalledWith("light");
    expect(getDozoTheme()).toBeUndefined();
    expect(picker()?.dataset.value).toBe("light");
  });

  it("ignores a choice that is neither a tone nor a theme", async () => {
    await act(async () => button("A choice no one offered").click());
    expect(device.set).not.toHaveBeenCalled();
    expect(picker()?.dataset.value).toBe("system");
  });

  it("shows a stored theme as chosen only beside its own tone", async () => {
    await act(async () => button("Sumi").click());
    await act(async () => {
      // The stored Light or Dark changed elsewhere while the name stayed.
      device.preference = "light";
      setDozoTheme("sumi");
    });
    expect(picker()?.dataset.value).toBe("light");
  });

  it("saves the message color on this device", async () => {
    await act(async () => button("Neutral").click());
    expect(getDozoBubble()).toBe("neutral");
    expect(container.querySelector<HTMLElement>("[role=radiogroup]")?.dataset.value).toBe(
      "neutral",
    );
    await act(async () => button("Bot color").click());
    expect(getDozoBubble()).toBe("bot");
  });
});
