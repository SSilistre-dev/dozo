// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import { flush } from "@rakazo/core/test-async";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Runs on the branded tree: the usage, command rule, quiet hours and pool procedures exist once
// the brand rules apply.

type Header = {
  title?: string;
  action?: { label: string; onPress: () => void } | null;
};
type MenuAction = {
  id: string;
  title: string;
  state?: string;
  attributes?: { disabled?: boolean };
};

const ui = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  share: vi.fn(),
  push: vi.fn(),
  header: undefined as Header | undefined,
  rosterReads: [] as (() => unknown)[],
  menus: [] as { title: string; actions: MenuAction[]; press: (id: string) => void }[],
}));

vi.mock("react-native", () => ({
  Alert: { alert: ui.alert },
  Share: { share: ui.share },
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("react-native-safe-area-context", () => ({
  SafeAreaView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: ui.push }) }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: MenuAction[];
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children?: ReactNode;
  }) => {
    ui.menus.push({ title, actions, press: (id) => onPressAction({ nativeEvent: { event: id } }) });
    return <>{children}</>;
  },
}));
vi.mock("./appearance", () => ({ mobileTokens: () => ({ destructive: "red" }) }));
vi.mock("./native", () => ({
  native: { groupedPage: "grouped", secondaryLabel: "secondary" },
  useResolvedAppearance: () => "dark",
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./i18n", () => ({ dateLocaleForUi: () => "en-US", useUiLocale: () => "en" }));
vi.mock("./screen-header", () => ({
  useScreenHeader: (header: Header) => {
    ui.header = header;
  },
}));
vi.mock("./side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("./roster-signals", () => ({
  useRosterSignals: (read: () => unknown, enabled: boolean) => {
    if (enabled) ui.rosterReads.push(read);
  },
}));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("./api-server", () => ({}));
vi.mock("./api-auth", () => ({}));
vi.mock("./api-live", () => ({}));
vi.mock("./api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async (spaceId: string | null = "space") => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: spaceId ? { "x-rakazo-space-id": spaceId } : {},
  }),
  rpc: ui.rpc,
}));
vi.mock("./session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("../components/native-segmented-control", () => ({
  NativeSegmentedControl: ({
    options,
    onChange,
    value,
  }: {
    options: { value: string; label: string }[];
    onChange: (value: string) => void;
    value: string;
  }) => (
    <nav>
      {options.map((option) => (
        <button
          type="button"
          key={option.value}
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </nav>
  ),
}));
vi.mock("../components/native-action-button", () => ({
  NativeActionButton: ({
    label,
    onPress,
    disabled,
  }: {
    label: string;
    onPress: () => void;
    disabled?: boolean;
  }) => (
    <button type="button" disabled={disabled} onClick={onPress}>
      {label}
    </button>
  ),
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  SettingsRow: ({
    title,
    detail,
    value,
    dimmed,
    onPress,
    onAccessibilityAction,
  }: {
    title: string;
    detail?: string;
    value?: string;
    dimmed?: boolean;
    onPress?: () => void;
    onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
  }) => (
    <li data-dimmed={dimmed ? "yes" : undefined}>
      <button
        type="button"
        onClick={onPress}
        onDoubleClick={() => onAccessibilityAction?.({ nativeEvent: { actionName: "remove" } })}
      >
        {title}
      </button>
      {detail ? <small>{detail}</small> : null}
      {value ? <b>{value}</b> : null}
    </li>
  ),
  SettingsSwitch: ({
    label,
    detail,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    detail?: string;
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
      {detail ? <small>{detail}</small> : null}
    </li>
  ),
}));

import DozoActivity from "../app/(settings)/dozo-activity";
import DozoCommands from "../app/(settings)/dozo-commands";
import DozoUsage from "../app/(settings)/dozo-usage";
import { DozoCommandsRow, dozoUsageLink } from "../components/dozo-account-rows";
import { DozoGeneralRows } from "../components/dozo-general-rows";
import { DozoModelPoolSwitch } from "../components/dozo-model-pool-switch";
import { dozoActivityAction } from "./dozo-activity";
import { queryClient } from "./query";

let answers: Record<string, unknown>;
let root: Root;
let container: HTMLDivElement;

async function render(node: ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}
const settle = (check: () => void) => act(() => vi.waitFor(check));
const text = () => container.textContent ?? "";
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((entry) => entry.textContent === label);
const calls = (path: string) => ui.rpc.mock.calls.filter(([called]) => called === path);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
  queryClient.clear();
  answers = {};
  ui.rpc.mockReset().mockImplementation(async (path: string, input: unknown) => {
    const value = answers[path];
    if (value instanceof Error) throw value;
    return typeof value === "function" ? value(input) : value;
  });
  for (const mock of [ui.alert, ui.share, ui.push]) mock.mockReset();
  ui.share.mockResolvedValue({ action: "sharedAction" });
  ui.header = undefined;
  ui.rosterReads = [];
  ui.menus = [];
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  vi.useRealTimers();
});

describe("usage on mobile", () => {
  const model = {
    key: "m",
    name: "fast-model",
    detail: "Provider",
    state: "live",
    modelCalls: 1200,
    inputTokens: 10,
    outputTokens: 5,
    totalTokens: 15,
    costUsd: 1.5,
  };

  it("groups the spend by model, bot or routine, as the server groups it", async () => {
    answers["dozoUsage/breakdown"] = ({ by }: { by: string }) =>
      by === "model"
        ? [model, { ...model, key: "t", name: "tiny", detail: null, costUsd: 0.004 }]
        : [
            { ...model, key: "a", name: null, state: "unknown", totalTokens: null, costUsd: null },
            { ...model, key: "b", name: null, state: "none" },
            { ...model, key: "c", name: "Old bot", detail: "x", state: "deleted" },
            { ...model, key: "d", name: null, state: "live" },
          ];
    await render(<DozoUsage />);
    await settle(() => expect(text()).toContain("fast-model"));
    expect(ui.header?.title).toBe("Usage");
    expect(text()).toContain("Provider, 1,200 calls, 15 tokens");
    expect(text()).toContain("$1.50");
    expect(text()).toContain("<$0.01");

    act(() => button("Bot")!.click());
    await settle(() => expect(text()).toContain("Unknown"));
    expect(text()).toContain("No bot");
    expect(text()).toContain("Deleted, 1,200 calls");
    expect(text()).toContain("—");
    expect(container.querySelectorAll("[data-dimmed]").length).toBe(3);

    act(() => button("Routine")!.click());
    await settle(() => expect(text()).toContain("No routine"));
    expect(calls("dozoUsage/breakdown").map(([, input]) => input)).toEqual([
      { by: "model" },
      { by: "bot" },
      { by: "routine" },
    ]);
  });

  it("hands the server's CSV to the share sheet, and says why when it cannot", async () => {
    answers["dozoUsage/breakdown"] = [model];
    answers["dozoUsage/csv"] = { csv: "group,calls\nfast-model,1200\n" };
    await render(<DozoUsage />);
    await settle(() => expect(ui.header?.action?.label).toBe("Export"));
    await act(async () => ui.header!.action!.onPress());
    await settle(() => expect(ui.share).toHaveBeenCalled());
    expect(ui.share.mock.lastCall![0]).toMatchObject({
      message: "group,calls\nfast-model,1200\n",
      title: expect.stringMatching(/^usage-model-\d{4}-\d{2}-\d{2}\.csv$/),
    });

    answers["dozoUsage/csv"] = new Error("Not now");
    await act(async () => ui.header!.action!.onPress());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not export", "Not now"));
  });

  it("offers no export with nothing to show, and says when the read fails", async () => {
    answers["dozoUsage/breakdown"] = new Error("Offline");
    await render(<DozoUsage />);
    await settle(() => expect(text()).toContain("Offline"));
    expect(ui.header?.action).toBeNull();
  });

  it("links the Usage row only once there is spend to group", () => {
    const open = vi.fn();
    expect(dozoUsageLink(null, open)).toEqual({});
    expect(dozoUsageLink({ models: [] } as never, open)).toEqual({});
    expect(dozoUsageLink({ models: [{}] } as never, open)).toEqual({
      accessibilityRole: "button",
      chevron: "right",
      onPress: open,
    });
  });
});

describe("commands on mobile", () => {
  const rules = [
    { id: "r1", botId: "b", botName: "Ada", words: ["npm", "test"], cwd: "~/app" },
    { id: "r2", botId: "b", botName: "Ada", words: ["make"], cwd: "" },
  ];

  it("shows the Commands row only while a command is always allowed", async () => {
    const open = vi.fn();
    answers["dozoCommandRules/list"] = [];
    await render(<DozoCommandsRow onPress={open} />);
    expect(text()).toBe("");
    queryClient.clear();
    answers["dozoCommandRules/list"] = rules;
    await render(<DozoCommandsRow key="again" onPress={open} />);
    await settle(() => expect(text()).toBe("Commands2"));
    act(() => button("Commands")!.click());
    expect(open).toHaveBeenCalledOnce();
  });

  it("lists each command with its bot and folder, and removes one", async () => {
    answers["dozoCommandRules/list"] = rules;
    await render(<DozoCommands />);
    await settle(() => expect(text()).toContain("npm test"));
    expect(ui.header?.title).toBe("Commands");
    expect(text()).toContain("Ada · ~/app");
    expect(ui.menus.at(-1)!.actions).toEqual([
      { id: "remove", title: "Remove", attributes: { destructive: true } },
    ]);

    answers["dozoCommandRules/remove"] = { ok: true };
    answers["dozoCommandRules/list"] = [rules[1]];
    await act(async () => ui.menus.find((menu) => menu.title === "npm test")!.press("remove"));
    await settle(() => expect(text()).not.toContain("npm test"));
    expect(calls("dozoCommandRules/remove")[0]![1]).toEqual({ id: "r1" });

    answers["dozoCommandRules/remove"] = new Error("Gone");
    await act(async () =>
      button("make")!.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })),
    );
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not remove rule", "Gone"));
  });
});

describe("general settings on mobile", () => {
  const checkbox = () => container.querySelector("input")!;

  it("turns quiet hours on with the night and moves their start and end", async () => {
    answers["dozoQuietHours/get"] = { hours: null };
    answers["audit/events"] = new Error("Forbidden");
    await render(<DozoGeneralRows />);
    await settle(() => expect(checkbox().disabled).toBe(false));
    expect(checkbox().checked).toBe(false);
    expect(text()).not.toContain("Activity");

    answers["dozoQuietHours/set"] = ({ hours }: { hours: unknown }) => ({ hours });
    answers["dozoQuietHours/get"] = { hours: { startMinute: 1320, endMinute: 420 } };
    await act(async () => checkbox().click());
    await settle(() => expect(text()).toContain("Quiet hours start10:00 PM"));
    expect(text()).toContain("Quiet hours end7:00 AM");
    expect(calls("dozoQuietHours/set")[0]![1]).toEqual({
      hours: { startMinute: 1320, endMinute: 420 },
    });

    const start = ui.menus.filter((menu) => menu.title === "Quiet hours start").at(-1)!;
    expect(start.actions).toHaveLength(24);
    expect(start.actions.find((action) => action.state === "on")!.title).toBe("10:00 PM");
    expect(start.actions.find((action) => action.attributes?.disabled)!.title).toBe("7:00 AM");
    answers["dozoQuietHours/get"] = { hours: { startMinute: 1380, endMinute: 420 } };
    await act(async () => start.press("1380"));
    await settle(() => expect(text()).toContain("Quiet hours start11:00 PM"));
    expect(calls("dozoQuietHours/set")[1]![1]).toEqual({
      hours: { startMinute: 1380, endMinute: 420 },
    });
  });

  it("keeps a start off the hour among the choices, and says when a change fails", async () => {
    answers["dozoQuietHours/get"] = { hours: { startMinute: 1350, endMinute: 420 } };
    answers["audit/events"] = new Error("Forbidden");
    await render(<DozoGeneralRows />);
    await settle(() => expect(text()).toContain("10:30 PM"));
    const start = ui.menus.filter((menu) => menu.title === "Quiet hours start").at(-1)!;
    expect(start.actions).toHaveLength(25);

    answers["dozoQuietHours/set"] = new Error("Try later");
    await act(async () => checkbox().click());
    await settle(() =>
      expect(ui.alert).toHaveBeenCalledWith("Couldn't update quiet hours", "Try later"),
    );
  });

  it("offers Activity to those who may read the log, and lists it a page at a time", async () => {
    answers["dozoQuietHours/get"] = { hours: null };
    const event = (id: string, extra = {}) => ({
      id,
      createdAt: "2026-11-20T10:00:00.000Z",
      organizationId: "o",
      spaceId: null,
      spaceName: "Home",
      actorType: "user",
      actorId: "u",
      actorLabel: "Ada",
      action: "auth.sign_in",
      targetType: null,
      targetId: null,
      targetLabel: null,
      outcome: "success",
      runId: null,
      ...extra,
    });
    answers["audit/events"] = ({ cursor }: { cursor?: string }) =>
      cursor
        ? { events: [event("e3", { action: "custom.thing" })], nextCursor: null }
        : {
            events: [
              event("e1"),
              event("e2", { action: "device.added", targetLabel: "Phone", outcome: "denied" }),
            ],
            nextCursor: "e2",
          };
    await render(<DozoGeneralRows />);
    await settle(() => expect(button("Activity")).toBeDefined());
    act(() => button("Activity")!.click());
    expect(ui.push).toHaveBeenCalledWith("/dozo-activity");

    await render(<DozoActivity />);
    await settle(() => expect(text()).toContain("Signed in"));
    expect(ui.header?.title).toBe("Activity");
    expect(text()).toContain("Changed devices Phone");
    expect(text()).toContain("Ada · Home · Denied ·");
    act(() => button("Load older")!.click());
    await settle(() => expect(text()).toContain("custom.thing"));
    expect(button("Load older")).toBeUndefined();
    expect(calls("audit/events").map(([, input]) => input)).toContainEqual({
      limit: 30,
      cursor: "e2",
    });
  });

  it("says when the log is empty or an older page fails", async () => {
    answers["audit/events"] = ({ cursor }: { cursor?: string }) => {
      if (cursor) throw new Error("Offline");
      return { events: [], nextCursor: "next" };
    };
    await render(<DozoActivity />);
    await settle(() => expect(text()).toContain("No activity yet"));
    await act(async () => button("Load older")!.click());
    await settle(() => expect(text()).toContain("Couldn't load more"));
  });

  it("names an action by its family, else not at all", () => {
    expect(dozoActivityAction("credential.deleted")?.message).toBe("Removed a credential");
    expect(dozoActivityAction("space.renamed")?.message).toBe("Changed a space");
    expect(dozoActivityAction("other")).toBeNull();
  });
});

describe("the model pool on mobile", () => {
  const pool = (connection: object | null) => ({
    connections: connection ? [{ credentialId: "c1", pooled: false, ...connection }] : [],
  });

  it("shows nothing where the server offers no pool", async () => {
    answers["dozoModelPool/get"] = pool(null);
    await render(<DozoModelPoolSwitch credentialId="c1" />);
    expect(text()).toBe("");
  });

  it("pools the provider's connections, and reads the pool again on a roster signal", async () => {
    answers["dozoModelPool/get"] = pool({});
    await render(<DozoModelPoolSwitch credentialId="c1" />);
    await settle(() => expect(text()).toBe("Use the next connection when one runs out"));
    answers["dozoModelPool/set"] = pool({ pooled: true });
    answers["dozoModelPool/get"] = pool({ pooled: true });
    await act(async () => container.querySelector("input")!.click());
    await settle(() => expect(container.querySelector("input")!.checked).toBe(true));
    expect(calls("dozoModelPool/set")[0]![1]).toEqual({ credentialId: "c1", pooled: true });

    const before = calls("dozoModelPool/get").length;
    await act(async () => {
      for (const read of ui.rosterReads) await read();
    });
    expect(calls("dozoModelPool/get").length).toBeGreaterThan(before);

    answers["dozoModelPool/set"] = new Error("Refused");
    await act(async () => container.querySelector("input")!.click());
    await settle(() => expect(ui.alert).toHaveBeenCalledWith("Could not save", "Refused"));
  });

  it("says when a resting connection opens, with its day when that is not today", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 10, 20, 9, 0));
    answers["dozoModelPool/get"] = pool({
      pooled: true,
      opensAt: new Date(2026, 10, 20, 14, 5).toISOString(),
    });
    await render(<DozoModelPoolSwitch credentialId="c1" />);
    await settle(() => expect(text()).toContain("Opens at 2:05 PM"));

    queryClient.clear();
    answers["dozoModelPool/get"] = pool({
      pooled: true,
      opensAt: new Date(2026, 10, 22, 8, 0).toISOString(),
    });
    await render(<DozoModelPoolSwitch key="later" credentialId="c1" />);
    await settle(() => expect(text()).toContain("Opens at Nov 22, 8:00 AM"));

    queryClient.clear();
    answers["dozoModelPool/get"] = pool({
      pooled: true,
      opensAt: new Date(2026, 10, 20, 8, 0).toISOString(),
    });
    await render(<DozoModelPoolSwitch key="past" credentialId="c1" />);
    await settle(() => expect(text()).toBe("Use the next connection when one runs out"));
  });
});
