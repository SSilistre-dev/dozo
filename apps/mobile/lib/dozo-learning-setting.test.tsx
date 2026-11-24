// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Save = {
  save: (input: string, send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onFailed?: (error: Error) => unknown;
};
const api = vi.hoisted(() => ({
  me: undefined as { userId: string } | undefined,
  learning: undefined as { mode: string; available: boolean } | undefined,
  reads: [] as Array<{ key: string; enabled: boolean }>,
  send: vi.fn(),
  alert: vi.fn(),
  saves: [] as Save[],
  pending: undefined as string | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./query", () => ({
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => {
    api.saves.push(options);
    return {
      pending: api.pending !== undefined,
      input: api.pending,
      run: (input: string) =>
        options.save(input, api.send).catch((error: Error) => options.onFailed?.(error)),
    };
  },
}));
vi.mock("./screen-query", () => ({
  useScreenQuery: (read: { queryKey: [string] }, options?: { enabled?: boolean }) => {
    const [key] = read.queryKey;
    api.reads.push({ key, enabled: options?.enabled ?? true });
    if (key === "me") return { data: api.me };
    return { data: options?.enabled ? api.learning : undefined };
  },
}));
vi.mock("../components/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../components/menu-picker", () => ({
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

import { DozoLearningSetting } from "../components/dozo-learning-setting";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render(ownerId: string | null = "owner") {
  await act(async () => root.render(<DozoLearningSetting botId="bot-1" ownerId={ownerId} />));
}
const picker = () => container.querySelector("fieldset");
const choice = (label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === label)!;

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.me = { userId: "owner" };
  api.learning = { mode: "off", available: true };
  api.reads = [];
  api.saves = [];
  api.pending = undefined;
  api.send.mockReset();
  api.alert.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("DozoLearningSetting", () => {
  it("offers the owner the web's three modes in one native menu, showing the saved one", async () => {
    api.learning = { mode: "ask", available: true };
    await render();
    expect(picker()?.getAttribute("aria-label")).toBe("Learn from chats");
    expect(picker()?.dataset.value).toBe("ask");
    expect([...container.querySelectorAll("button")].map((button) => button.textContent)).toEqual([
      "Off",
      "Ask first",
      "Auto",
    ]);
    expect(api.reads).toContainEqual({ key: "dozoLearning/get", enabled: true });
  });

  it("saves the picked mode for this bot and reads the setting again", async () => {
    api.send.mockResolvedValue({ mode: "auto" });
    await render();
    await act(async () => choice("Auto").click());
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoLearning/setMode", {
      botId: "bot-1",
      mode: "auto",
    });
    expect(api.saves.at(-1)?.stale).toEqual([["dozoLearning/get", { botId: "bot-1" }]]);
  });

  it("shows the mode being saved and holds the menu until it is done", async () => {
    api.pending = "ask";
    await render();
    expect(picker()?.dataset.value).toBe("ask");
    expect(picker()?.disabled).toBe(true);
  });

  it("says why the server refused the mode", async () => {
    api.send.mockRejectedValue(new Error("Learning works only in a Space of your own."));
    await render();
    await act(async () => choice("Ask first").click());
    expect(api.alert).toHaveBeenCalledWith("Learning works only in a Space of your own.");
  });

  it("shows no one but the bot's owner anything, and asks the server nothing for them", async () => {
    api.me = { userId: "member" };
    await render();
    expect(container.innerHTML).toBe("");
    expect(api.reads).toContainEqual({ key: "dozoLearning/get", enabled: false });
    await render(null);
    expect(container.innerHTML).toBe("");
  });

  it("offers nothing in a Space with someone else in it, or on a server without the setting", async () => {
    api.learning = { mode: "off", available: false };
    await render();
    expect(container.innerHTML).toBe("");
    api.learning = undefined;
    await render();
    expect(container.innerHTML).toBe("");
  });
});
