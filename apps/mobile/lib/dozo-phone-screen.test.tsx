// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CalendarSwitchResult, PhoneSettings } from "./dozo-phone-device";

type AlertButton = { text: string; style?: string; onPress?: () => void };

const ui = vi.hoisted(() => ({
  alert: vi.fn(),
  openSettings: vi.fn(async () => undefined),
  header: undefined as { title?: string } | undefined,
  apiBase: "https://app.example.test",
  available: true,
}));

const phone = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = { settings: { ready: true, calendar: false } as PhoneSettings };
  return {
    state,
    set(settings: PhoneSettings) {
      state.settings = settings;
      for (const listener of listeners) listener();
    },
    device: {
      settings: () => state.settings,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      sync: vi.fn(async () => undefined),
      setCalendar: vi.fn(async (_on: boolean): Promise<CalendarSwitchResult> => "done"),
    },
  };
});

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  Linking: { openSettings: ui.openSettings },
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native", () => ({
  native: { groupedPage: "grouped" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./screen-header", () => ({
  useScreenHeader: (header: { title?: string }) => {
    ui.header = header;
  },
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./dozo-phone-device", () => ({ phoneDevice: () => phone.device }));
vi.mock("./dozo-phone-calendar", () => ({ calendarAvailable: () => ui.available }));
vi.mock("./api", () => ({
  currentApiBase: () => ui.apiBase,
  subscribeApiBase: () => () => undefined,
}));
vi.mock("./dozo-relay-endpoint", () => ({
  isRelayServer: (url: string) => url.endsWith(".computer.dozo.invalid"),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children, footer }: { children?: ReactNode; footer?: string }) => (
    <ul>
      {children}
      {footer ? <li data-footer="">{footer}</li> : null}
    </ul>
  ),
  SettingsRow: ({ title, onPress }: { title: string; onPress?: () => void }) => (
    <li>
      <button type="button" onClick={onPress}>
        {title}
      </button>
    </li>
  ),
  SettingsSwitch: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <li>
      <label>
        <input
          type="checkbox"
          checked={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
    </li>
  ),
}));

const { default: DozoPhone } = await import("../app/(settings)/dozo-phone");
const { DozoPhoneRow } = await import("./dozo-phone-row");

let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const toggle = () => container.querySelector<HTMLInputElement>("input[type=checkbox]")!;
const tap = () => act(async () => toggle().click());
const alertButtons = () => (ui.alert.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  ui.alert.mockReset();
  ui.openSettings.mockClear();
  ui.apiBase = "https://app.example.test";
  ui.available = true;
  phone.state.settings = { ready: true, calendar: false };
  phone.device.sync.mockClear();
  phone.device.setCalendar.mockReset().mockResolvedValue("done");
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the Phone screen", () => {
  it("is titled Phone, starts with Calendar off, and says where read events go", async () => {
    await render(<DozoPhone />);
    expect(ui.header?.title).toBe("Phone");
    expect(container.querySelector("label")?.textContent).toBe("Calendar");
    expect(toggle().checked).toBe(false);
    expect(container.querySelector("[data-footer]")?.textContent).toBe(
      "Events a bot reads are sent to its AI model.",
    );
    expect(container.textContent).toBe("CalendarEvents a bot reads are sent to its AI model.");
    expect(phone.device.sync).toHaveBeenCalled();
  });

  it("holds the switch until the phone's state is known", async () => {
    phone.state.settings = { ready: false, calendar: false };
    await render(<DozoPhone />);
    expect(toggle().disabled).toBe(true);
    await act(async () => phone.set({ ready: true, calendar: true }));
    expect(toggle().disabled).toBe(false);
    expect(toggle().checked).toBe(true);
  });

  it("shows the tapped value while switching, then what the phone reports", async () => {
    const switching = deferred<CalendarSwitchResult>();
    phone.device.setCalendar.mockReturnValueOnce(switching.promise);
    await render(<DozoPhone />);
    await tap();
    expect(phone.device.setCalendar).toHaveBeenCalledWith(true);
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    await act(async () => {
      phone.set({ ready: true, calendar: true });
      switching.resolve("done");
    });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(ui.alert).not.toHaveBeenCalled();
  });

  it("stays off when the system refuses, and offers the system settings", async () => {
    phone.device.setCalendar.mockResolvedValueOnce("denied");
    await render(<DozoPhone />);
    await tap();
    await act(() => flush());
    expect(toggle().checked).toBe(false);
    expect(ui.alert).toHaveBeenCalledWith(
      "Allow calendar access in Settings.",
      undefined,
      expect.any(Array),
    );
    expect(alertButtons().map((button) => button.text)).toEqual(["Cancel", "Settings"]);
    alertButtons()[1]!.onPress?.();
    expect(ui.openSettings).toHaveBeenCalled();
  });

  it("says so when pairing fails, and stays off", async () => {
    phone.device.setCalendar.mockRejectedValueOnce(new Error("Remove a computer first"));
    await render(<DozoPhone />);
    await tap();
    await act(() => flush());
    expect(ui.alert).toHaveBeenCalledWith("Remove a computer first");
    expect(toggle().checked).toBe(false);
  });

  it("turns Calendar off", async () => {
    phone.state.settings = { ready: true, calendar: true };
    await render(<DozoPhone />);
    await tap();
    expect(phone.device.setCalendar).toHaveBeenCalledWith(false);
  });
});

describe("the Phone row", () => {
  it("opens the screen on a direct server with the calendar module", async () => {
    const open = vi.fn();
    await render(<DozoPhoneRow onPress={open} />);
    await act(async () => container.querySelector("button")!.click());
    expect(container.textContent).toBe("Phone");
    expect(open).toHaveBeenCalled();
  });

  it("is not shown over the relay", async () => {
    ui.apiBase = `https://${"ab".repeat(16)}.computer.dozo.invalid`;
    await render(<DozoPhoneRow onPress={vi.fn()} />);
    expect(container.textContent).toBe("");
  });

  it("is not shown in a build without the calendar module", async () => {
    ui.available = false;
    await render(<DozoPhoneRow onPress={vi.fn()} />);
    expect(container.textContent).toBe("");
  });
});
