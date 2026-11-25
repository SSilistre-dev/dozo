// @vitest-environment jsdom
import { i18n } from "@lingui/core";
import type { Routine } from "@rakazo/contracts";
import { draftFromRoutine } from "@rakazo/core";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

// A bot's one-time wait is an ordinary watching routine with no schedule (adapters
// `dozo-wait.ts`): the list must name it by its watch, never as an unknown schedule.

vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
}));
vi.mock("./native/native", () => ({
  native: { groupedPage: "grouped" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./layout/side-insets", () => ({ useSideInsets: () => ({}) }));
vi.mock("../components/native/native-switch", () => ({
  NativeSwitch: ({ value, accessibilityLabel }: { value: boolean; accessibilityLabel: string }) => (
    <input type="checkbox" readOnly checked={value} aria-label={accessibilityLabel} />
  ),
}));
vi.mock("../components/settings/settings-group", () => ({
  useStackedSettings: () => false,
  SettingsGroup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  SettingsRow: ({
    title,
    detail,
    accessibilityLabel,
    trailing,
  }: {
    title: string;
    detail?: string;
    accessibilityLabel?: string;
    trailing?: ReactNode;
  }) => (
    <li aria-label={accessibilityLabel}>
      <b>{title}</b>
      <small>{detail}</small>
      {trailing}
    </li>
  ),
}));

import { RoutineList } from "../components/routines/routine-list";
import { routineRowDetail, routineTriggerRows } from "./routines/routine";
import { routineDraftChanged, routineSaveRequest } from "./routines/routine-draft";

const wait = (extra: Partial<Routine> = {}): Routine => ({
  id: "routine-wait",
  botId: "bot-1",
  name: "Wait for the deploy page",
  prompt: "Tell me what changed.",
  crons: [],
  timezone: "UTC",
  active: true,
  notify: true,
  inChat: false,
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
  modelProvider: null,
  modelId: null,
  thinkingLevel: null,
  watch: { kind: "http", url: "https://status.example.test", everyMinutes: 5, loud: false },
  watchState: null,
  lastRunAt: null,
  // The deadline, which the wait's next check is moved onto.
  nextRunAt: "2026-11-21T12:00:00.000Z",
  endsAt: null,
  createdAt: "2026-11-21T10:00:00.000Z",
  ...extra,
});

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  i18n.load("en", {});
  i18n.activate("en");
});

describe("a bot's one-time wait in the routines list", () => {
  it("is named by its watch, with the zone only when it is not the device's", () => {
    expect(routineRowDetail(wait(), "UTC")).toBe("When something changes");
    expect(routineRowDetail(wait({ timezone: "Europe/Berlin" }), "UTC")).toBe(
      "When something changes (Europe/Berlin)",
    );
    expect(routineTriggerRows(wait(), "UTC")).toEqual(["When something changes"]);
  });

  it("shows Paused once the wait has ended and switched itself off", () => {
    expect(routineRowDetail(wait({ active: false }), "UTC")).toBe("When something changes, Paused");
  });

  it("renders its row with the bot's name and the switch on", async () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () =>
      root.render(
        <RoutineList
          routines={[wait(), wait({ id: "ended", name: "Ended wait", active: false })]}
          timeZone="UTC"
          canDelete
          onOpen={() => undefined}
          onToggle={() => undefined}
          onDelete={() => undefined}
        />,
      ),
    );
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.querySelector("b")?.textContent)).toEqual([
      "Wait for the deploy page",
      "Ended wait",
    ]);
    expect(rows.map((row) => row.querySelector("small")?.textContent)).toEqual([
      "When something changes",
      "When something changes, Paused",
    ]);
    expect(rows[0]!.getAttribute("aria-label")).toBe("Wait for the deploy page, On");
    expect(rows[1]!.getAttribute("aria-label")).toBe("Ended wait, Off");
    expect([...container.querySelectorAll("input")].map((input) => input.checked)).toEqual([
      true,
      false,
    ]);
    await act(async () => root.unmount());
  });

  it("opens in the editor unchanged, renames without touching its watch, and keeps a trigger", () => {
    const routine = wait();
    const draft = draftFromRoutine(routine);
    expect(routineDraftChanged(draft, routine)).toBe(false);
    expect(routineSaveRequest(draft, routine, "bot-1", "UTC")).toEqual({ unchanged: true });
    expect(routineSaveRequest({ ...draft, name: "Deploy wait" }, routine, "bot-1", "UTC")).toEqual({
      update: { routineId: "routine-wait", name: "Deploy wait" },
    });
    // Removing its only trigger would leave nothing to start it: the editor refuses.
    expect(routineSaveRequest({ ...draft, watch: null }, routine, "bot-1", "UTC")).toEqual({
      error: "trigger",
    });
  });
});
