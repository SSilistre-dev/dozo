// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { deferred, flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PhoneKind, PhoneSettings, PhoneSwitchResult } from "./dozo-phone-device";

type AlertButton = { text: string; style?: string; onPress?: () => void };

const ui = vi.hoisted(() => ({
  alert: vi.fn(),
  openSettings: vi.fn(async () => undefined),
  header: undefined as { title?: string } | undefined,
  apiBase: "https://app.example.test",
  available: true,
  contacts: true,
  location: true,
  reminders: true,
  platform: { OS: "ios" },
}));

const OFF: PhoneSettings = {
  ready: true,
  calendar: false,
  contacts: false,
  location: false,
  reminders: false,
  "calendar-write": false,
  "reminders-write": false,
};

const phone = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const state = {
    settings: {
      ready: true,
      calendar: false,
      contacts: false,
      location: false,
      reminders: false,
      "calendar-write": false,
      "reminders-write": false,
    } as PhoneSettings,
  };
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
      setSwitch: vi.fn(
        async (_kind: PhoneKind, _on: boolean): Promise<PhoneSwitchResult> => "done",
      ),
    },
  };
});

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  Linking: { openSettings: ui.openSettings },
  Platform: ui.platform,
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native/native", () => ({
  native: { groupedPage: "grouped" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./navigation/screen-header", () => ({
  useScreenHeader: (header: { title?: string }) => {
    ui.header = header;
  },
}));
vi.mock("./layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./dozo-phone-device", () => ({ phoneDevice: () => phone.device }));
vi.mock("./dozo-phone-calendar", () => ({ calendarAvailable: () => ui.available }));
vi.mock("./dozo-phone-contacts", () => ({ contactsAvailable: () => ui.contacts }));
vi.mock("./dozo-phone-location", () => ({ locationAvailable: () => ui.location }));
vi.mock("./dozo-phone-reminders", () => ({ remindersAvailable: () => ui.reminders }));
vi.mock("./api/api", () => ({
  currentApiBase: () => ui.apiBase,
  subscribeApiBase: () => () => undefined,
}));
vi.mock("./dozo-relay-endpoint", () => ({
  isRelayServer: (url: string) => url.endsWith(".computer.dozo.invalid"),
}));
vi.mock("../components/settings/settings-group", () => ({
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
const toggles = () => [...container.querySelectorAll<HTMLInputElement>("input[type=checkbox]")];
const toggle = (index = 0) => toggles()[index]!;
const tap = (index = 0) => act(async () => toggle(index).click());
const labels = () => [...container.querySelectorAll("label")].map((label) => label.textContent);
const alertButtons = () => (ui.alert.mock.calls.at(-1)?.[2] ?? []) as AlertButton[];

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  ui.alert.mockReset();
  ui.openSettings.mockClear();
  ui.apiBase = "https://app.example.test";
  ui.available = true;
  ui.contacts = true;
  ui.location = true;
  ui.reminders = true;
  ui.platform.OS = "ios";
  phone.state.settings = OFF;
  phone.device.sync.mockClear();
  phone.device.setSwitch.mockReset().mockResolvedValue("done");
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("the Phone screen", () => {
  it("is titled Phone, starts with every switch off, and says where what bots read goes", async () => {
    await render(<DozoPhone />);
    expect(ui.header?.title).toBe("Phone");
    expect(labels()).toEqual([
      "Calendar",
      "Contacts",
      "Location",
      "Reminders",
      "Add to calendar",
      "Add reminders",
    ]);
    expect(toggles().map((input) => input.checked)).toEqual(Array(6).fill(false));
    expect(container.querySelector("[data-footer]")?.textContent).toBe(
      "What a bot reads is sent to its AI model.",
    );
    expect(container.textContent).toBe(
      "CalendarContactsLocationRemindersAdd to calendarAdd remindersWhat a bot reads is sent to its AI model.",
    );
    expect(phone.device.sync).toHaveBeenCalled();
  });

  it("hides a switch in a build without its module", async () => {
    ui.contacts = false;
    await render(<DozoPhone />);
    expect(labels()).toEqual([
      "Calendar",
      "Location",
      "Reminders",
      "Add to calendar",
      "Add reminders",
    ]);
    ui.contacts = true;
    ui.location = false;
    await render(<DozoPhone />);
    expect(labels()).toEqual([
      "Calendar",
      "Contacts",
      "Reminders",
      "Add to calendar",
      "Add reminders",
    ]);
  });

  it("shows only Add to calendar of the writes on Android, which keeps no reminders", async () => {
    ui.platform.OS = "android";
    ui.reminders = false;
    await render(<DozoPhone />);
    expect(labels()).toEqual(["Calendar", "Contacts", "Location", "Add to calendar"]);
    await tap(3);
    expect(phone.device.setSwitch).toHaveBeenCalledWith("calendar-write", true);
  });

  it("switches each of reminders and writes on its own", async () => {
    await render(<DozoPhone />);
    await tap(3);
    expect(phone.device.setSwitch).toHaveBeenLastCalledWith("reminders", true);
    await tap(4);
    expect(phone.device.setSwitch).toHaveBeenLastCalledWith("calendar-write", true);
    await tap(5);
    expect(phone.device.setSwitch).toHaveBeenLastCalledWith("reminders-write", true);
    await act(async () => phone.set({ ...OFF, "reminders-write": true }));
    expect(toggles().map((input) => input.checked)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    await tap(5);
    expect(phone.device.setSwitch).toHaveBeenLastCalledWith("reminders-write", false);
  });

  it("switches each kind on its own, holding all while one switches", async () => {
    const switching = deferred<PhoneSwitchResult>();
    phone.device.setSwitch.mockReturnValueOnce(switching.promise);
    await render(<DozoPhone />);
    await tap(2);
    expect(phone.device.setSwitch).toHaveBeenCalledWith("location", true);
    expect(toggles().map((input) => input.checked)).toEqual([
      false,
      false,
      true,
      false,
      false,
      false,
    ]);
    expect(toggles().every((input) => input.disabled)).toBe(true);
    await act(async () => {
      phone.set({ ...OFF, location: true });
      switching.resolve("done");
    });
    expect(toggles().some((input) => input.disabled)).toBe(false);
    await tap(1);
    expect(phone.device.setSwitch).toHaveBeenLastCalledWith("contacts", true);
  });

  it.each([
    [1, "Allow contacts access in Settings."],
    [2, "Allow location access in Settings."],
    [3, "Allow reminders access in Settings."],
    [4, "Allow calendar access in Settings."],
    [5, "Allow reminders access in Settings."],
  ])("offers the system settings when switch %i is refused", async (index, line) => {
    phone.device.setSwitch.mockResolvedValueOnce("denied");
    await render(<DozoPhone />);
    await tap(index);
    await act(() => flush());
    expect(toggle(index).checked).toBe(false);
    expect(ui.alert).toHaveBeenCalledWith(line, undefined, expect.any(Array));
    alertButtons()[1]!.onPress?.();
    expect(ui.openSettings).toHaveBeenCalled();
  });

  it("holds the switch until the phone's state is known", async () => {
    phone.state.settings = { ...OFF, ready: false };
    await render(<DozoPhone />);
    expect(toggle().disabled).toBe(true);
    await act(async () => phone.set({ ...OFF, calendar: true }));
    expect(toggle().disabled).toBe(false);
    expect(toggle().checked).toBe(true);
  });

  it("shows the tapped value while switching, then what the phone reports", async () => {
    const switching = deferred<PhoneSwitchResult>();
    phone.device.setSwitch.mockReturnValueOnce(switching.promise);
    await render(<DozoPhone />);
    await tap();
    expect(phone.device.setSwitch).toHaveBeenCalledWith("calendar", true);
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(true);
    await act(async () => {
      phone.set({ ...OFF, calendar: true });
      switching.resolve("done");
    });
    expect(toggle().checked).toBe(true);
    expect(toggle().disabled).toBe(false);
    expect(ui.alert).not.toHaveBeenCalled();
  });

  it("stays off when the system refuses, and offers the system settings", async () => {
    phone.device.setSwitch.mockResolvedValueOnce("denied");
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
    phone.device.setSwitch.mockRejectedValueOnce(new Error("Remove a computer first"));
    await render(<DozoPhone />);
    await tap();
    await act(() => flush());
    expect(ui.alert).toHaveBeenCalledWith("Remove a computer first");
    expect(toggle().checked).toBe(false);
  });

  it("turns Calendar off", async () => {
    phone.state.settings = { ...OFF, calendar: true };
    await render(<DozoPhone />);
    await tap();
    expect(phone.device.setSwitch).toHaveBeenCalledWith("calendar", false);
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
