// @vitest-environment jsdom
import { DOZO_NIGHT_NOTES_ROUTINE_PROMPT } from "@rakazo/contracts";
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Save = {
  save: (input: boolean, send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onFailed?: (error: Error) => unknown;
};

const api = vi.hoisted(() => ({
  routines: undefined as unknown[] | undefined,
  me: undefined as { timezone: string | null } | undefined,
  send: vi.fn(),
  alert: vi.fn(),
  pending: undefined as boolean | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./api/user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./query/query", () => ({
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => ({
    pending: api.pending !== undefined,
    input: api.pending,
    run: (on: boolean) =>
      options.save(on, api.send).catch((error: Error) => options.onFailed?.(error)),
  }),
}));
vi.mock("./query/screen-query", () => ({
  useScreenQuery: (read: { queryKey: [string, unknown] }) => ({
    data: read.queryKey[0] === "me" ? api.me : api.routines,
  }),
}));
vi.mock("./routines/routine", () => ({ deviceTimeZone: () => "America/Los_Angeles" }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsSwitch: ({
    label,
    value,
    disabled,
    onChange,
  }: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (on: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      disabled={disabled}
      onClick={() => onChange(!value)}
    />
  ),
}));

import { DozoNightNotesRow } from "../components/dozo-night-notes-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const toggle = () => container.querySelector<HTMLButtonElement>("[role=switch]");
const render = () => act(async () => root.render(<DozoNightNotesRow botId="bot-1" />));

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.routines = [];
  api.me = { timezone: "Europe/Istanbul" };
  api.pending = undefined;
  api.send
    .mockReset()
    .mockImplementation(async (proc: string) => (proc === "routines/list" ? api.routines : {}));
  api.alert.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DozoNightNotesRow on mobile", () => {
  it("shows nothing until the bot's routines are read", async () => {
    api.routines = undefined;
    await render();
    expect(toggle()).toBeNull();
  });

  it("switching on creates the daily routine in the account's zone, or the device's without one", async () => {
    await render();
    expect(toggle()?.getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle()?.click());
    expect(api.send).toHaveBeenLastCalledWith(
      "routines/create",
      expect.objectContaining({ botId: "bot-1", timezone: "Europe/Istanbul", active: true }),
    );
    api.me = { timezone: null };
    await render();
    await act(async () => toggle()?.click());
    expect(api.send).toHaveBeenLastCalledWith(
      "routines/create",
      expect.objectContaining({ timezone: "America/Los_Angeles" }),
    );
  });

  it("shows a running routine as on and switching off pauses it", async () => {
    api.routines = [{ id: "r1", prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT, active: true }];
    await render();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle()?.click());
    expect(api.send).toHaveBeenLastCalledWith("routines/update", {
      routineId: "r1",
      active: false,
    });
  });

  it("shows the switch as the save sends it while pending, and says when a save fails", async () => {
    api.pending = true;
    await render();
    expect(toggle()?.getAttribute("aria-checked")).toBe("true");
    expect(toggle()?.disabled).toBe(true);
    api.pending = undefined;
    api.send.mockRejectedValue(new Error("Nope"));
    await render();
    await act(async () => toggle()?.click());
    expect(api.alert).toHaveBeenCalledWith("Nope");
  });
});
