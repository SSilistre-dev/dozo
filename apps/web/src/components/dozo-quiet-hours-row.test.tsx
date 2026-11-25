// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps, ReactNode } from "react";
import { act, createContext, useContext } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  get: vi.fn(),
  set: vi.fn(),
  suggest: vi.fn(),
  toast: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../lib/query/rpc", () => {
  const rpc = { dozoQuietHours: { set: api.set } };
  return { rpc, rpcForSpace: () => rpc, createSpaceRpc: () => rpc, selectedSpaceId: () => null };
});
vi.mock("../lib/query/query", async (importOriginal) => ({
  ...(await importOriginal<typeof Query>()),
  useSpaceQueries: () => ({
    dozoQuietHours: {
      get: {
        key: () => ["quiet"],
        queryOptions: () => ({ queryKey: ["quiet"], queryFn: () => api.get() }),
      },
      suggest: { call: () => api.suggest() },
    },
  }),
}));
vi.mock("../../../../packages/i18n/src/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => {
  const Group = createContext<{ value: string[]; onValueChange: (value: string[]) => void }>({
    value: [],
    onValueChange: () => undefined,
  });
  return {
    Button: ({ variant: _variant, size: _size, ...props }: ComponentProps<"button"> & Style) => (
      <button type="button" {...props} />
    ),
    Label: ({ htmlFor, children, className }: ComponentProps<"label">) => (
      <label htmlFor={htmlFor} className={className}>
        {children}
      </label>
    ),
    OptionSelect: ({
      options,
      value,
      onValueChange,
      size: _size,
      "data-testid": testId,
      ...props
    }: {
      options: { value: string; label: string; disabled?: boolean }[];
      value: string | null;
      onValueChange: (value: string) => void;
      size?: string;
      "data-testid"?: string;
    } & Omit<ComponentProps<"select">, "value" | "onChange" | "size">) => (
      <select
        data-testid={testId}
        {...props}
        value={value ?? ""}
        onChange={(event) => onValueChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>
    ),
    Switch: ({
      checked,
      onCheckedChange,
      ...props
    }: {
      checked: boolean;
      onCheckedChange: (checked: boolean) => void;
      id: string;
      disabled?: boolean;
    }) => (
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onCheckedChange(event.target.checked)}
        {...props}
      />
    ),
    ToggleGroup: ({
      value,
      onValueChange,
      children,
      multiple: _multiple,
      size: _size,
      ...props
    }: {
      value: string[];
      onValueChange: (value: string[]) => void;
      children: ReactNode;
      multiple?: boolean;
      size?: string;
    }) => (
      <fieldset data-slot="toggle-group" {...props}>
        <Group.Provider value={{ value, onValueChange }}>{children}</Group.Provider>
      </fieldset>
    ),
    ToggleGroupItem: function Item({
      value,
      ...props
    }: ComponentProps<"button"> & { value: string }) {
      const group = useContext(Group);
      const pressed = group.value.includes(value);
      return (
        <button
          type="button"
          aria-pressed={pressed}
          {...props}
          onClick={() =>
            group.onValueChange(
              pressed ? group.value.filter((entry) => entry !== value) : [...group.value, value],
            )
          }
        />
      );
    },
    toast: Object.assign(api.toast, { error: api.toastError }),
  };
});

type Style = { variant?: string; size?: string };

import type * as Query from "../lib/query/query";
import { DozoQuietHoursRow } from "./dozo-quiet-hours-row";

const NIGHT = { startMinute: 1320, endMinute: 420, days: 127 };
const WEEKEND_MORNING = { startMinute: 360, endMinute: 600, days: 96 };

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <DozoQuietHoursRow />
      </QueryClientProvider>,
    );
  });
}

const toggle = () => container.querySelector<HTMLInputElement>('input[type="checkbox"]');
const selects = (label: string) => [
  ...container.querySelectorAll<HTMLSelectElement>(`select[aria-label="${label}"]`),
];
const select = (label: string, index = 0) => selects(label)[index] ?? null;
const button = (name: string) =>
  [...container.querySelectorAll("button")].find(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent) === name,
  );
const buttons = (name: string) =>
  [...container.querySelectorAll("button")].filter(
    (entry) => (entry.getAttribute("aria-label") ?? entry.textContent) === name,
  );
const dayButtons = () => [
  ...container.querySelectorAll<HTMLButtonElement>('[data-slot="toggle-group"] [aria-pressed]'),
];

async function loaded() {
  await render();
  await vi.waitFor(() => expect(toggle()?.disabled).toBe(false));
}

async function choose(node: HTMLSelectElement | null, value: string) {
  if (!node) throw new Error("Missing select");
  await act(async () => {
    node.value = value;
    node.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function click(node: HTMLElement | undefined) {
  if (!node) throw new Error("Missing button");
  await act(async () => node.click());
}

/** Waits until the save in flight has settled, so the next control takes a change. */
const settled = () => vi.waitFor(() => expect(toggle()?.disabled).toBe(false));

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  for (const mock of Object.values(api)) mock.mockReset();
  api.set.mockImplementation(async ({ ranges }) => {
    api.get.mockResolvedValue({ hours: null, ranges });
    return { hours: null, ranges };
  });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it("shows only its switch and Suggest while off, named by its label", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  await loaded();
  expect(toggle()?.checked).toBe(false);
  expect(container.querySelector(`label[for="${toggle()?.id}"]`)?.textContent).toBe("Quiet hours");
  expect(container.querySelectorAll("select")).toHaveLength(0);
  expect(button("Add range")).toBeUndefined();
  expect(button("Suggest")).toBeDefined();
  // Nothing is asked for until Suggest is pressed.
  expect(api.suggest).not.toHaveBeenCalled();
});

it("turns on for the night on every day, then shows when they start and end", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ ranges: [NIGHT] });
  await vi.waitFor(() => expect(toggle()?.checked).toBe(true));
  expect(select("Quiet hours start")?.value).toBe("1320");
  expect(select("Quiet hours end")?.value).toBe("420");
  expect(select("Quiet hours start")?.selectedOptions[0]?.textContent).toBe("22:00");
  // The end cannot be where it starts.
  expect(
    select("Quiet hours end")?.querySelector<HTMLOptionElement>('option[value="1320"]')?.disabled,
  ).toBe(true);
  // The days read as one choice until a person asks for single days.
  expect(select("Days")?.selectedOptions[0]?.textContent).toBe("Every day");
  expect(dayButtons()).toHaveLength(0);
  // One range is taken away with the switch, not a button of its own.
  expect(button("Remove")).toBeUndefined();
  expect(button("Add range")).toBeDefined();
  expect(api.suggest).not.toHaveBeenCalled();
});

it("changes one edge and keeps the other", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [NIGHT] });
  await loaded();
  await choose(select("Quiet hours end"), "480");
  expect(api.set).toHaveBeenCalledWith({ ranges: [{ ...NIGHT, endMinute: 480 }] });
  await vi.waitFor(() => expect(select("Quiet hours end")?.value).toBe("480"));
  await settled();
  await choose(select("Quiet hours start"), "1380");
  expect(api.set).toHaveBeenLastCalledWith({
    ranges: [{ ...NIGHT, startMinute: 1380, endMinute: 480 }],
  });
});

it("keeps a start set off the hour among the choices", async () => {
  api.get.mockResolvedValue({
    hours: null,
    ranges: [{ startMinute: 22 * 60 + 30, endMinute: 6 * 60, days: 127 }],
  });
  await loaded();
  expect(select("Quiet hours start")?.value).toBe("1350");
  expect(select("Quiet hours start")?.options).toHaveLength(25);
});

it("turns off", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [NIGHT, WEEKEND_MORNING] });
  await loaded();
  await act(async () => toggle()?.click());
  expect(api.set).toHaveBeenCalledWith({ ranges: [] });
  await vi.waitFor(() => expect(container.querySelectorAll("select")).toHaveLength(0));
});

it("adds ranges up to four, and removes one while there are more", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [NIGHT, WEEKEND_MORNING, NIGHT] });
  await loaded();
  expect(selects("Quiet hours start")).toHaveLength(3);
  expect(buttons("Remove")).toHaveLength(3);
  await click(button("Add range"));
  expect(api.set).toHaveBeenCalledWith({ ranges: [NIGHT, WEEKEND_MORNING, NIGHT, NIGHT] });
  await vi.waitFor(() => expect(selects("Quiet hours start")).toHaveLength(4));
  await settled();
  expect(button("Add range")).toBeUndefined();

  // An edge of the second range changes that range only.
  await choose(select("Quiet hours end", 1), "660");
  expect(api.set).toHaveBeenLastCalledWith({
    ranges: [NIGHT, { ...WEEKEND_MORNING, endMinute: 660 }, NIGHT, NIGHT],
  });
  await settled();

  await click(buttons("Remove")[1]);
  expect(api.set).toHaveBeenLastCalledWith({ ranges: [NIGHT, NIGHT, NIGHT] });
  await vi.waitFor(() => expect(selects("Quiet hours start")).toHaveLength(3));
  await settled();
  expect(button("Add range")).toBeDefined();
});

it("picks the days by name, or one by one but never none", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [NIGHT] });
  await loaded();
  await choose(select("Days"), "WEEKEND");
  expect(api.set).toHaveBeenLastCalledWith({ ranges: [{ ...NIGHT, days: 96 }] });
  await vi.waitFor(() => expect(select("Days")?.value).toBe("WEEKEND"));
  await settled();

  // Asking for single days saves nothing; it shows the week, the weekend pressed.
  const saves = api.set.mock.calls.length;
  await choose(select("Days"), "custom");
  expect(api.set).toHaveBeenCalledTimes(saves);
  expect(dayButtons().map((day) => day.getAttribute("aria-label"))).toEqual([
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
    "Sunday",
  ]);
  expect(dayButtons().map((day) => day.getAttribute("aria-pressed"))).toEqual([
    "false",
    "false",
    "false",
    "false",
    "false",
    "true",
    "true",
  ]);

  await click(dayButtons()[2]);
  expect(api.set).toHaveBeenLastCalledWith({ ranges: [{ ...NIGHT, days: 0b1100100 }] });
  await settled();
  expect(select("Days")?.value).toBe("custom");

  await click(dayButtons()[6]);
  expect(api.set).toHaveBeenLastCalledWith({ ranges: [{ ...NIGHT, days: 0b0100100 }] });
  await settled();
  await click(dayButtons()[5]);
  expect(api.set).toHaveBeenLastCalledWith({ ranges: [{ ...NIGHT, days: 0b0000100 }] });
  await settled();

  // The last day left cannot be taken out.
  expect(dayButtons()[2]?.disabled).toBe(true);
  const before = api.set.mock.calls.length;
  await click(dayButtons()[2]);
  expect(api.set).toHaveBeenCalledTimes(before);
});

it("shows single days at once for a choice that has no name", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [{ ...NIGHT, days: 0b0010101 }] });
  await loaded();
  expect(select("Days")?.value).toBe("custom");
  expect(dayButtons().filter((day) => day.getAttribute("aria-pressed") === "true")).toHaveLength(3);
});

it("previews a suggestion and saves it only when it is used", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  api.suggest.mockResolvedValue({ ranges: [NIGHT, WEEKEND_MORNING] });
  await loaded();
  await click(button("Suggest"));
  expect(api.suggest).toHaveBeenCalledOnce();
  await vi.waitFor(() => expect(button("Use")).toBeDefined());
  const preview = container.querySelector('[data-testid="dozo-quiet-hours-suggestion"]');
  expect(preview?.textContent).toContain("22:00 – 7:00");
  expect(preview?.textContent).toContain("Every day");
  expect(preview?.textContent).toContain("6:00 – 10:00");
  expect(preview?.textContent).toContain("Weekends");
  expect(api.set).not.toHaveBeenCalled();
  expect(toggle()?.checked).toBe(false);

  await click(button("Use"));
  expect(api.set).toHaveBeenCalledWith({ ranges: [NIGHT, WEEKEND_MORNING] });
  await vi.waitFor(() => expect(selects("Quiet hours start")).toHaveLength(2));
  expect(button("Use")).toBeUndefined();
  expect(toggle()?.checked).toBe(true);
});

it("drops a suggestion that is cancelled, saving nothing", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [NIGHT] });
  api.suggest.mockResolvedValue({ ranges: [WEEKEND_MORNING] });
  await loaded();
  await click(button("Suggest"));
  await vi.waitFor(() => expect(button("Use")).toBeDefined());
  await click(button("Cancel"));
  await vi.waitFor(() => expect(button("Use")).toBeUndefined());
  expect(container.querySelector('[data-testid="dozo-quiet-hours-suggestion"]')).toBeNull();
  expect(api.set).not.toHaveBeenCalled();
  expect(selects("Quiet hours start")).toHaveLength(1);
});

it("says in one line when there is too little to suggest from", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  api.suggest.mockResolvedValue({ ranges: null });
  await loaded();
  await click(button("Suggest"));
  await vi.waitFor(() => expect(api.toast).toHaveBeenCalledWith("Not enough activity yet."));
  expect(button("Use")).toBeUndefined();
  expect(api.set).not.toHaveBeenCalled();
});

it("says so when a suggestion cannot be read", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  api.suggest.mockRejectedValue(new Error("down"));
  await loaded();
  await click(button("Suggest"));
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Something went wrong. Try again."),
  );
  expect(api.set).not.toHaveBeenCalled();
});

it("says so when the save fails, and shows the saved hours again", async () => {
  api.get.mockResolvedValue({ hours: null, ranges: [] });
  api.set.mockRejectedValue(new Error("down"));
  await loaded();
  await act(async () => toggle()?.click());
  await vi.waitFor(() =>
    expect(api.toastError).toHaveBeenCalledWith("Couldn't update quiet hours"),
  );
  await vi.waitFor(() => expect(toggle()?.checked).toBe(false));
});

it("stays off and still while the saved hours cannot be read", async () => {
  api.get.mockRejectedValue(new Error("down"));
  await render();
  await vi.waitFor(() => expect(api.get).toHaveBeenCalled());
  expect(toggle()?.disabled).toBe(true);
  expect(api.suggest).not.toHaveBeenCalled();
});
