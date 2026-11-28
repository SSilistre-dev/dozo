// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Briefing = {
  available: boolean;
  coHostBotId: string | null;
  coHosts: Array<{ id: string; name: string }>;
};
type Save = {
  save: (input: string | null, send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onFailed?: (error: Error) => unknown;
};
const api = vi.hoisted(() => ({
  briefing: undefined as Briefing | undefined,
  send: vi.fn(),
  alert: vi.fn(),
  saves: [] as Save[],
  pending: false,
  pendingInput: undefined as string | null | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./api/user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./query/query", () => ({
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => {
    api.saves.push(options);
    return {
      pending: api.pending,
      input: api.pendingInput,
      run: (input: string | null) =>
        options.save(input, api.send).catch((error: Error) => options.onFailed?.(error)),
    };
  },
}));
vi.mock("./query/screen-query", () => ({
  useScreenQuery: () => ({ data: api.briefing }),
}));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../components/ui/menu-picker", () => ({
  MenuPicker: (props: {
    label: string;
    choices: Array<{ key: string; label: string }>;
    value: string;
    disabled?: boolean;
    onChange: (key: string) => void;
  }) => (
    <fieldset aria-label={props.label} disabled={props.disabled} data-value={props.value}>
      {props.choices.map((choice) => (
        <button key={choice.key} type="button" onClick={() => props.onChange(choice.key)}>
          {choice.label}
        </button>
      ))}
    </fieldset>
  ),
}));

import { DozoRoutineBriefing } from "../components/dozo-routine-briefing";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const nova = { id: "bot-2", name: "Nova" };

beforeEach(() => {
  vi.clearAllMocks();
  api.send.mockReset().mockResolvedValue(undefined);
  api.saves = [];
  api.pending = false;
  api.pendingInput = undefined;
  api.briefing = { available: true, coHostBotId: null, coHosts: [nova] };
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function render() {
  act(() => root.render(<DozoRoutineBriefing routineId="routine-1" />));
}
const picker = () => container.querySelector("fieldset");
const choose = async (label: string) => {
  const button = [...container.querySelectorAll("button")].find(
    (item) => item.textContent === label,
  );
  await act(async () => button!.click());
};

describe("the spoken briefing row of a routine", () => {
  it("shows nothing while the briefing is unknown or cannot be spoken and none is set", () => {
    api.briefing = undefined;
    render();
    expect(container.innerHTML).toBe("");
    api.briefing = { available: false, coHostBotId: null, coHosts: [nova] };
    render();
    expect(container.innerHTML).toBe("");
  });

  it("offers Off and the owner's other voiced bots, and saves a pick at once", async () => {
    render();
    expect(picker()?.getAttribute("aria-label")).toBe("Spoken briefing");
    expect(picker()?.getAttribute("data-value")).toBe("");
    expect([...container.querySelectorAll("button")].map((item) => item.textContent)).toEqual([
      "Off",
      "Nova",
    ]);
    await choose("Nova");
    expect(api.send).toHaveBeenCalledWith("dozoSpokenBriefings/set", {
      routineId: "routine-1",
      coHostBotId: "bot-2",
    });
    expect(api.saves[0]?.stale).toEqual([["dozoSpokenBriefings/get", { routineId: "routine-1" }]]);
  });

  it("still lets a set briefing be turned off, and shows the pick while it saves", async () => {
    api.briefing = { available: false, coHostBotId: "bot-2", coHosts: [nova] };
    api.pending = true;
    api.pendingInput = null;
    render();
    expect(picker()?.getAttribute("data-value")).toBe("");
    expect(picker()?.hasAttribute("disabled")).toBe(true);
    api.pending = false;
    render();
    expect(picker()?.getAttribute("data-value")).toBe("bot-2");
    await choose("Off");
    expect(api.send).toHaveBeenCalledWith("dozoSpokenBriefings/set", {
      routineId: "routine-1",
      coHostBotId: null,
    });
  });

  it("says a failed save", async () => {
    api.send.mockRejectedValue(new Error("Not found"));
    render();
    await choose("Nova");
    expect(api.alert).toHaveBeenCalledWith("Not found");
  });
});
