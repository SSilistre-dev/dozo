// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Choice = { provider: string; modelId: string; credentialId?: string };
type Save = {
  save: (input: Choice[], send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onFailed?: (error: Error) => unknown;
};
type Row = {
  title: string;
  detail?: string;
  disabled?: boolean;
  onPress?: () => void;
  onAccessibilityAction?: (event: { nativeEvent: { actionName: string } }) => void;
};

const entry = (id: string, label: string, provider = "alpha") => ({
  provider,
  providerName: "Alpha",
  id,
  label,
  billing: "",
  managed: true,
});

const api = vi.hoisted(() => ({
  me: undefined as { userId: string } | undefined,
  backups: undefined as { backups: Choice[] } | undefined,
  catalog: [] as unknown[],
  credentials: [] as unknown[],
  reads: [] as Array<{ key: string; input: unknown; enabled: boolean }>,
  send: vi.fn(),
  alert: vi.fn(),
  push: vi.fn(),
  signals: [] as Array<() => unknown>,
  invalidate: vi.fn(),
  saves: [] as Save[],
  pending: undefined as Choice[] | undefined,
  rest: undefined as string | undefined,
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray | { message: string }, ...values: unknown[]) =>
      "message" in strings
        ? strings.message
        : strings.flatMap((part, index) => [part, values[index] ?? ""]).join(""),
  }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: api.alert },
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: api.push }) }));
vi.mock("@expo/ui/community/menu", () => ({
  MenuView: ({
    title,
    actions,
    onPressAction,
    children,
  }: {
    title: string;
    actions: Array<{ id: string; title: string }>;
    onPressAction: (event: { nativeEvent: { event: string } }) => void;
    children: ReactNode;
  }) => (
    <div role="menu" aria-label={title}>
      {children}
      {actions.map((action) => (
        <button
          key={action.id}
          type="button"
          onClick={() => onPressAction({ nativeEvent: { event: action.id } })}
        >
          {`${title}: ${action.title}`}
        </button>
      ))}
    </div>
  ),
}));
vi.mock("./dozo-model-rests", () => ({
  useDozoRestNote: () => () => api.rest,
}));
vi.mock("./native/native", () => ({
  useMobileTokens: () => ({ mutedForeground: "#999999" }),
  useResolvedAppearance: () => "dark",
}));
vi.mock("./api/user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./query/query", () => ({
  queryClient: { invalidateQueries: api.invalidate },
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => {
    api.saves.push(options);
    return {
      pending: api.pending !== undefined,
      input: api.pending,
      run: (input: Choice[]) =>
        options.save(input, api.send).catch((error: Error) => options.onFailed?.(error)),
    };
  },
}));
vi.mock("./api/roster-signals", () => ({
  useRosterSignals: (read: () => unknown) => {
    api.signals.push(read);
  },
}));
vi.mock("./query/screen-query", () => ({
  useScreenQuery: (
    read: { queryKey: [string, unknown] },
    options?: { enabled?: boolean },
  ): { data: unknown } => {
    const [key, input] = read.queryKey;
    const enabled = options?.enabled ?? true;
    api.reads.push({ key, input, enabled });
    if (!enabled) return { data: undefined };
    if (key === "me") return { data: api.me };
    if (key === "dozoBotModelBackups/get") return { data: api.backups };
    if (key === "models/credentials") return { data: api.credentials };
    return { data: api.catalog };
  },
}));
vi.mock("../components/dozo-night-notes-row", () => ({ DozoNightNotesRow: () => null }));
vi.mock("../components/dozo-bot-stats-row", () => ({ DozoBotStatsRow: () => null }));
vi.mock("../components/native/native-symbol", () => ({ NativeSymbol: () => null }));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SettingsRow: (row: Row) => (
    <div>
      <button type="button" disabled={row.disabled} onClick={row.onPress}>
        {row.title}
      </button>
      {row.detail ? <small>{row.detail}</small> : null}
      <button
        type="button"
        onClick={() => row.onAccessibilityAction?.({ nativeEvent: { actionName: "moveDown" } })}
      >
        {`${row.title}: action`}
      </button>
    </div>
  ),
}));

import { DozoBotBackups } from "../components/dozo-bot-backups";
import { modelPickerRequest, selectPickerModel } from "./models/model-picker-selection";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function render() {
  await act(async () => root.render(<DozoBotBackups botId="bot-1" />));
}
const text = (label: string) =>
  [...container.querySelectorAll("button")].find((button) => button.textContent === label);
const click = (label: string) => act(async () => text(label)?.click());
const requestId = () => {
  const [route] = api.push.mock.lastCall ?? [];
  return (route as { params: { requestId: string } }).params.requestId;
};
const choose = (key: string) => act(async () => void selectPickerModel(requestId(), key));
const key = (modelId: string) => JSON.stringify(["alpha", modelId, null]);
const backup = (modelId: string): Choice => ({ provider: "alpha", modelId });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.me = { userId: "me-1" };
  api.backups = { backups: [backup("m2"), backup("m3")] };
  api.catalog = [entry("m1", "One"), entry("m2", "Two"), entry("m3", "Three"), entry("m4", "Four")];
  api.credentials = [];
  api.reads = [];
  api.saves = [];
  api.signals = [];
  api.pending = undefined;
  api.rest = undefined;
  api.send.mockReset();
  api.send.mockResolvedValue({ backups: [] });
  api.alert.mockReset();
  api.push.mockReset();
  api.invalidate.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("DozoBotBackups", () => {
  it("lists the bot's backups in order, each with the connection that runs it", async () => {
    await render();
    const rows = [...container.querySelectorAll("section > div")].map((row) => row.textContent);
    expect(rows[0]).toContain("Two");
    expect(rows[0]).toContain("Alpha");
    expect(rows[1]).toContain("Three");
    expect(text("Add fallback")).toBeDefined();
  });

  it("reads this bot's list, the models of the person's own connections, and again on the roster signal", async () => {
    await render();
    expect(api.reads).toContainEqual({
      key: "dozoBotModelBackups/get",
      input: { botId: "bot-1" },
      enabled: true,
    });
    expect(api.reads).toContainEqual({
      key: "models/forRole",
      input: { role: "main", expectedUserId: "me-1" },
      enabled: true,
    });
    api.signals.at(-1)?.();
    expect(api.invalidate).toHaveBeenCalledWith({
      queryKey: ["dozoBotModelBackups/get", { botId: "bot-1" }],
    });
  });

  it("asks for no model list before it knows who is asking", async () => {
    api.me = undefined;
    await render();
    expect(api.reads).toContainEqual({
      key: "models/forRole",
      input: { role: "main", expectedUserId: "" },
      enabled: false,
    });
  });

  it("shows nothing on a server without the setting or one that cannot be read", async () => {
    api.backups = undefined;
    await render();
    expect(container.innerHTML).toBe("");
  });

  it("says when a model rests, in place of its connection", async () => {
    api.rest = "Opens at 9:00 AM";
    await render();
    expect(container.textContent).toContain("Opens at 9:00 AM");
  });

  it("falls back to the model's id while the catalog is not read", async () => {
    api.catalog = [];
    await render();
    expect(container.textContent).toContain("m2");
    expect(text("Add fallback")).toBeUndefined();
  });

  it("moves a backup down, saving the whole list for this bot and reading it again", async () => {
    await render();
    await click("Two options: Move down");
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m3"), backup("m2")],
    });
    expect(api.saves.at(-1)?.stale).toEqual([["dozoBotModelBackups/get", { botId: "bot-1" }]]);
  });

  it("offers Move up only below the first, Move down only above the last", async () => {
    await render();
    expect(text("Two options: Move up")).toBeUndefined();
    expect(text("Three options: Move down")).toBeUndefined();
    expect(text("Three options: Move up")).toBeDefined();
    expect(text("Two options: Remove")).toBeDefined();
  });

  it("moves a backup up, and moves it from the screen reader's actions too", async () => {
    await render();
    await click("Three options: Move up");
    expect(api.send).toHaveBeenLastCalledWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m3"), backup("m2")],
    });
    await click("Two: action");
    expect(api.send).toHaveBeenLastCalledWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m3"), backup("m2")],
    });
  });

  it("removes a backup", async () => {
    await render();
    await click("Two options: Remove");
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m3")],
    });
  });

  it("adds from the searchable list of models no row has, at the end", async () => {
    await render();
    await click("Add fallback");
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/model-picker",
      params: { requestId: expect.any(String) },
    });
    const request = modelPickerRequest(requestId());
    expect(request?.title).toBe("Add fallback");
    expect(request?.choices.map((choice) => choice.modelLabel)).toEqual(["One", "Four"]);
    await choose(key("m4"));
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m2"), backup("m3"), backup("m4")],
    });
  });

  it("changes a row to another model from the same list", async () => {
    await render();
    await click("Two");
    expect(modelPickerRequest(requestId())?.title).toBe("Change Two");
    await choose(key("m1"));
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m1"), backup("m3")],
    });
  });

  it("applies a pick to the list as it is when the pick comes back", async () => {
    await render();
    await click("Add fallback");
    const id = requestId();
    api.backups = { backups: [backup("m2")] };
    await render();
    await act(async () => void selectPickerModel(id, key("m4")));
    expect(api.send).toHaveBeenCalledWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [backup("m2"), backup("m4")],
    });
  });

  it("keeps the connection a model runs on, names it, and saves it with the row", async () => {
    api.credentials = [
      { id: "cred-1", provider: "alpha", label: "Work", hasKey: true, isDefault: true },
    ];
    api.backups = { backups: [{ provider: "alpha", modelId: "m2", credentialId: "cred-1" }] };
    await render();
    expect(container.textContent).toContain("Work");
    await click("Add fallback");
    await choose(JSON.stringify(["alpha", "m4", "cred-1"]));
    expect(api.send).toHaveBeenCalledExactlyOnceWith("dozoBotModelBackups/set", {
      botId: "bot-1",
      backups: [
        { provider: "alpha", modelId: "m2", credentialId: "cred-1" },
        { provider: "alpha", modelId: "m4", credentialId: "cred-1" },
      ],
    });
  });

  it("does nothing for a pick that is not in the list it offered", async () => {
    await render();
    await click("Add fallback");
    modelPickerRequest(requestId())?.onSelect({ key: "gone", label: "Gone" });
    expect(api.send).not.toHaveBeenCalled();
  });

  it("does not move the last backup down or the first up from the screen reader's actions", async () => {
    await render();
    await click("Three: action");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("offers no more models than the server takes", async () => {
    api.backups = {
      backups: Array.from({ length: 10 }, (_, index) => backup(`x${index}`)),
    };
    await render();
    expect(text("Add fallback")).toBeUndefined();
  });

  it("offers no add when every model is already a backup", async () => {
    api.catalog = [entry("m2", "Two"), entry("m3", "Three")];
    await render();
    expect(text("Add fallback")).toBeUndefined();
  });

  it("shows the list being saved and holds its controls until it is done", async () => {
    api.pending = [backup("m3")];
    await render();
    expect(container.textContent).not.toContain("Two");
    expect(text("Three")?.disabled).toBe(true);
    expect(text("Add fallback")?.disabled).toBe(true);
    await click("Three: action");
    expect(api.send).not.toHaveBeenCalled();
  });

  it("says why the server refused the list", async () => {
    api.send.mockRejectedValue(new Error("Too many backups."));
    await render();
    await click("Two options: Remove");
    expect(api.alert).toHaveBeenCalledWith("Too many backups.");
  });
});
