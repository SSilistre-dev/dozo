// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Save = {
  save: (input: boolean, send: unknown) => Promise<unknown>;
  onFailed?: (error: Error) => unknown;
};

const api = vi.hoisted(() => ({
  state: undefined as { allowed: boolean; available: boolean } | undefined,
  send: vi.fn(),
  alert: vi.fn(),
  pending: undefined as boolean | undefined,
  signals: [] as Array<() => unknown>,
  invalidate: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (strings: TemplateStringsArray) => strings.join("") }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./api/user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./api/roster-signals", () => ({
  useRosterSignals: (read: () => unknown) => {
    api.signals.push(read);
  },
}));
vi.mock("./query/query", () => ({
  queryClient: { invalidateQueries: api.invalidate },
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => ({
    pending: api.pending !== undefined,
    input: api.pending,
    run: (input: boolean) =>
      options.save(input, api.send).catch((error: Error) => options.onFailed?.(error)),
  }),
}));
vi.mock("./query/screen-query", () => ({ useScreenQuery: () => ({ data: api.state }) }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children: React.ReactNode }) => <section>{children}</section>,
  SettingsSwitch: (props: {
    label: string;
    value: boolean;
    disabled?: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button type="button" disabled={props.disabled} onClick={() => props.onChange(!props.value)}>
      {`${props.label}: ${props.value ? "on" : "off"}`}
    </button>
  ),
}));

import { DozoBotCallsRow } from "../components/dozo-bot-calls-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.state = { allowed: false, available: true };
  api.pending = undefined;
  api.send.mockReset().mockResolvedValue({});
  api.alert.mockReset();
  api.invalidate.mockReset();
  api.signals = [];
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

const render = () => act(async () => root.render(<DozoBotCallsRow botId="bot-1" />));

describe("DozoBotCallsRow", () => {
  it("shows the switch off and turns it on", async () => {
    await render();
    expect(container.textContent).toBe("Can call me: off");
    await act(async () => container.querySelector("button")?.click());
    expect(api.send).toHaveBeenCalledWith("dozoBotCalls/set", { botId: "bot-1", allowed: true });
  });

  it("reads again on a roster signal, which another of your devices sends", async () => {
    await render();
    api.signals.at(-1)?.();
    expect(api.invalidate).toHaveBeenCalledWith({ queryKey: ["dozoBotCalls/get", { botId: "bot-1" }] });
  });

  it("shows what a save in flight sends", async () => {
    api.pending = true;
    await render();
    expect(container.textContent).toBe("Can call me: on");
  });

  it("shows nothing where calls are not available", async () => {
    api.state = { allowed: false, available: false };
    await render();
    expect(container.textContent).toBe("");
  });

  it("says so when the save fails", async () => {
    api.send.mockRejectedValue(new Error("no"));
    await render();
    await act(async () => container.querySelector("button")?.click());
    expect(api.alert).toHaveBeenCalledWith("no");
  });
});
