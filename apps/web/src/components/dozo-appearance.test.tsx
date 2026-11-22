// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  upstream: vi.fn((preference: string) => (preference === "light" ? "light" : "dark")),
  select: undefined as undefined | ((value: string) => void),
}));

vi.mock("../lib/ui-appearance", () => ({
  getUiAppearancePreference: () => "dark",
  setUiAppearance: api.upstream,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
// The menu and the segmented control as plain buttons: what is under test is what a choice does.
vi.mock("@rakazo/ui-web", async () => {
  const { createContext, useContext } = await import("react");
  type Choice = { value: string; onValueChange: (value: string) => void };
  const Picked = createContext<Choice>({ value: "", onValueChange: () => undefined });
  type Props = { children?: ReactNode; value?: string; [key: string]: unknown };
  const Pass = ({ children }: Props) => <>{children}</>;
  return {
    Select: ({ value, onValueChange, children }: Props & Choice) => {
      api.select = onValueChange;
      return <Picked.Provider value={{ value, onValueChange }}>{children}</Picked.Provider>;
    },
    SelectTrigger: ({ children, ...props }: Props) => (
      <button type="button" {...props}>
        {children}
      </button>
    ),
    SelectValue: ({ children }: { children: (value: string) => ReactNode }) =>
      children(useContext(Picked).value),
    SelectContent: Pass,
    SelectGroup: Pass,
    SelectSeparator: () => <hr />,
    SelectItem: ({ value, children, label: _label, ...props }: Props) => {
      const picked = useContext(Picked);
      return (
        <button
          type="button"
          role="option"
          aria-selected={picked.value === value}
          onClick={() => picked.onValueChange(value as string)}
          {...props}
        >
          {children}
        </button>
      );
    },
    ToggleGroup: ({
      value,
      onValueChange,
      children,
      spacing: _spacing,
      ...props
    }: Props & { value: string[]; onValueChange: (value: string[]) => void }) => (
      <div {...props}>
        <Picked.Provider
          value={{ value: value[0] ?? "", onValueChange: (next) => onValueChange([next]) }}
        >
          {children}
        </Picked.Provider>
      </div>
    ),
    ToggleGroupItem: ({ value, children, ...props }: Props) => {
      const picked = useContext(Picked);
      return (
        <button
          type="button"
          aria-pressed={picked.value === value}
          onClick={() => picked.onValueChange(value as string)}
          {...props}
        >
          {children}
        </button>
      );
    },
  };
});

import { setDozoBubble, setUiAppearance } from "../lib/dozo-ui-theme";
import { DozoAppearancePicker, DozoMessageColorPicker } from "./dozo-appearance";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const onChange = vi.fn();

const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const trigger = () => byTestId("ui-appearance-select")?.textContent;

async function show(value: "system" | "light" | "dark") {
  await act(async () =>
    root.render(
      <>
        <DozoAppearancePicker value={value} onChange={onChange} />
        <DozoMessageColorPicker />
      </>,
    ),
  );
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  onChange.mockClear();
  api.upstream.mockClear();
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  setUiAppearance("dark");
  setDozoBubble("bot");
  localStorage.clear();
});

it("shows today's choice unchanged with no theme stored", async () => {
  await show("dark");
  expect(trigger()).toBe("Dark");
  await show("system");
  expect(trigger()).toBe("System");
  expect(byTestId("dozo-message-color-bot")?.getAttribute("aria-pressed")).toBe("true");
});

it("offers System, Light and Dark, then the six named themes, each with its name", async () => {
  await show("dark");
  const options = [...container.querySelectorAll('[role="option"]')].map(
    (node) => node.textContent,
  );
  expect(options).toEqual([
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
  expect(container.querySelector("hr")).not.toBeNull();
});

it("picks a named theme: its tone goes to upstream's choice and the name beside it", async () => {
  await show("dark");
  await act(async () => byTestId("ui-appearance-washi")?.click());
  expect(localStorage.getItem("dozo.uiTheme")).toBe("washi");
  expect(document.documentElement.dataset.skin).toBe("washi");
  expect(onChange).toHaveBeenCalledWith("light");
  await show("light");
  expect(trigger()).toBe("Washi");
});

it("lets go of a named theme when System, Light or Dark is picked", async () => {
  localStorage.setItem("dozo.uiTheme", "yoru");
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })),
  );
  await show("dark");
  expect(trigger()).toBe("Yoru");
  await act(async () => byTestId("ui-appearance-system")?.click());
  expect(localStorage.getItem("dozo.uiTheme")).toBeNull();
  expect(document.documentElement.dataset.skin).toBeUndefined();
  expect(onChange).toHaveBeenCalledWith("system");
});

it("reads a theme stored under the other tone, or an unknown one, as the plain choice", async () => {
  localStorage.setItem("dozo.uiTheme", "yoru");
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })),
  );
  await show("light");
  expect(trigger()).toBe("Light");
  localStorage.setItem("dozo.uiTheme", "neon");
  await act(async () =>
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage })),
  );
  await show("dark");
  expect(trigger()).toBe("Dark");
});

it("ignores a value that is no choice", async () => {
  await show("dark");
  await act(async () => api.select?.("neon"));
  expect(onChange).not.toHaveBeenCalled();
  expect(api.upstream).not.toHaveBeenCalled();
});

it("sets the message colour from its segmented control", async () => {
  await show("dark");
  await act(async () => byTestId("dozo-message-color-neutral")?.click());
  expect(localStorage.getItem("dozo.uiBubble")).toBe("neutral");
  expect(document.documentElement.dataset.bubble).toBe("neutral");
  expect(byTestId("dozo-message-color-neutral")?.getAttribute("aria-pressed")).toBe("true");
  expect(byTestId("dozo-message-color")?.getAttribute("aria-label")).toBe("Message color");
});
