// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Save = {
  save: (input: never, send: unknown) => Promise<unknown>;
  stale?: unknown[];
  onSaved?: (result: never) => unknown;
  onFailed?: (error: Error) => unknown;
};

const api = vi.hoisted(() => ({
  status: { data: undefined, isError: false } as { data?: unknown; isError: boolean },
  preview: undefined as unknown,
  send: vi.fn(),
  alert: vi.fn(),
  share: vi.fn(),
  push: vi.fn(),
  header: undefined as unknown,
  previewInputs: [] as unknown[],
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
    i18n: { date: (value: Date) => value.toISOString().slice(0, 10) },
  }),
}));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: api.push }),
  useLocalSearchParams: () => ({ botId: "bot-1", name: "Ada" }),
}));
vi.mock("react-native", () => ({
  Alert: { alert: api.alert },
  Share: { share: api.share },
  StyleSheet: { create: <T,>(styles: T) => styles },
  ScrollView: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <p>{children}</p>,
}));
vi.mock("./api/user-error", () => ({
  errorText: (error: Error, fallback: string) => error.message || fallback,
}));
vi.mock("./native/native", () => ({
  native: { label: "label" },
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("./navigation/screen-header", () => ({
  useScreenHeader: (options: unknown) => {
    api.header = options;
  },
}));
vi.mock("./query/query", () => ({
  rpcQuery: (proc: string, input?: unknown) => ({ queryKey: [proc, input] }),
  useSave: (options: Save) => ({
    pending: false,
    run: (input: never) =>
      options
        .save(input, api.send)
        .then((result) => options.onSaved?.(result as never))
        .catch((error: Error) => options.onFailed?.(error)),
  }),
}));
vi.mock("./query/screen-query", () => ({
  useScreenQuery: (read: { queryKey: [string, unknown] }) => {
    if (read.queryKey[0] === "dozoBotShares/status") return api.status;
    api.previewInputs.push(read.queryKey[1]);
    return { data: api.preview };
  },
}));
vi.mock("../components/settings/settings-group", () => ({
  SettingsGroup: ({ label, children }: { label?: string; children?: ReactNode }) => (
    <section>
      {label ? <h2>{label}</h2> : null}
      {children}
    </section>
  ),
  SettingsFooter: ({ children }: { children: string }) => <small>{children}</small>,
  SettingsRow: ({
    title,
    onPress,
    destructive,
    disabled,
  }: {
    title: string;
    onPress?: () => void;
    destructive?: boolean;
    disabled?: boolean;
  }) =>
    onPress ? (
      <button type="button" data-destructive={destructive} disabled={disabled} onClick={onPress}>
        {title}
      </button>
    ) : (
      <span>{title}</span>
    ),
  SettingsSwitch: ({
    label,
    value,
    onChange,
  }: {
    label: string;
    value: boolean;
    onChange: (value: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-label={label}
      aria-checked={value}
      onClick={() => onChange(!value)}
    >
      {String(value)}
    </button>
  ),
}));

import DozoBotShare from "../app/dozo-bot-share";
import { useDozoBotShareActions } from "../components/dozo-bot-share";
import { useDozoBotActions } from "../components/dozo-extensions";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const buttons = () => [...container.querySelectorAll("button")];
const button = (text: string) => buttons().find((b) => b.textContent === text);

const definition = {
  name: "Ada",
  avatar: { color: null, avatarSet: null },
  instructions: "Be kind.\nBe brief.",
  description: "Helpful",
  routines: [{ name: "Morning", prompt: "Hi", crons: ["0 8 * * *", "0 9 * * 1"] }],
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  api.status = { data: { link: null }, isError: false };
  api.preview = { definition, fingerprint: "f".repeat(64), hasPicture: false };
  api.previewInputs = [];
  api.send.mockReset().mockResolvedValue({ url: "https://example.test/s/x" });
  api.alert.mockReset();
  api.share.mockReset().mockResolvedValue({});
  api.push.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function List({ actions }: { actions: { id: string; text: string; onPress: () => void }[] }) {
  return (
    <>
      {actions.map((action) => (
        <button type="button" key={action.id} onClick={action.onPress}>
          {action.text}
        </button>
      ))}
    </>
  );
}
const Actions = () => <List actions={useDozoBotShareActions("bot-1", "Ada")} />;
const ExtensionActions = () => <List actions={useDozoBotActions("bot-1", "Ada")} />;

describe("bot share action", () => {
  it("is hidden when the status read fails or has not answered", async () => {
    api.status = { data: undefined, isError: true };
    await act(async () => root.render(<Actions />));
    expect(buttons()).toHaveLength(0);
    api.status = { data: undefined, isError: false };
    await act(async () => root.render(<Actions />));
    expect(buttons()).toHaveLength(0);
  });

  it("opens the share screen for an owner, through the bot actions", async () => {
    await act(async () => root.render(<ExtensionActions />));
    expect(buttons().map((b) => b.textContent)).toEqual(["Share link"]);
    await act(async () => buttons()[0]?.click());
    expect(api.push).toHaveBeenCalledWith({
      pathname: "/dozo-bot-share",
      params: { botId: "bot-1", name: "Ada" },
    });
  });
});

describe("bot share screen", () => {
  const render = () => act(async () => root.render(<DozoBotShare />));

  it("shows exactly the text that becomes public and leaves out empty fields", async () => {
    await render();
    expect(api.header).toEqual({ title: "Share link" });
    const text = container.textContent ?? "";
    for (const part of [
      "Ada",
      "Instructions",
      "Be kind.\nBe brief.",
      "How other bots see it",
      "Helpful",
      "Routines",
      "Morning\n0 8 * * *, 0 9 * * 1",
      "Anyone with the link can see this and make their own copy.",
      "Create link",
    ])
      expect(text).toContain(part);
    expect(container.querySelector("[role=switch]")).toBeNull();
    expect(button("Revoke link")).toBeUndefined();
    api.preview = {
      definition: { ...definition, description: "", routines: [] },
      fingerprint: "f",
      hasPicture: false,
    };
    await render();
    expect(container.textContent).not.toContain("How other bots see it");
    expect(container.textContent).not.toContain("Routines");
  });

  it("shows nothing until the preview is read", async () => {
    api.preview = undefined;
    await render();
    expect(container.textContent).toBe("");
  });

  it("offers the picture only when the bot has one, and previews with the choice", async () => {
    api.preview = { definition, fingerprint: "f".repeat(64), hasPicture: true };
    await render();
    await act(async () => container.querySelector<HTMLElement>("[role=switch]")?.click());
    expect(api.previewInputs.at(-1)).toEqual({ botId: "bot-1", includePicture: true });
    await act(async () => button("Create link")?.click());
    expect(api.send).toHaveBeenCalledWith("dozoBotShares/publish", {
      botId: "bot-1",
      includePicture: true,
      fingerprint: "f".repeat(64),
    });
  });

  it("creates the link with the previewed fingerprint and opens the share sheet", async () => {
    await render();
    await act(async () => button("Create link")?.click());
    expect(api.send).toHaveBeenCalledWith("dozoBotShares/publish", {
      botId: "bot-1",
      includePicture: false,
      fingerprint: "f".repeat(64),
    });
    expect(api.share).toHaveBeenCalledWith({
      url: "https://example.test/s/x",
      message: "https://example.test/s/x",
    });
  });

  it("alerts when publishing or opening the share sheet fails", async () => {
    await render();
    api.send.mockRejectedValue(new Error("Changed"));
    await act(async () => button("Create link")?.click());
    expect(api.alert).toHaveBeenCalledWith("Changed");
    api.send.mockResolvedValue({ url: "https://example.test/s/x" });
    api.share.mockRejectedValue(new Error(""));
    await act(async () => button("Create link")?.click());
    expect(api.alert).toHaveBeenLastCalledWith("Could not share");
  });

  it("with a live link shows its expiry, makes a new link, and revokes after asking", async () => {
    api.status = {
      data: { link: { id: "l1", expiresAt: "2027-02-01T00:00:00.000Z" } },
      isError: false,
    };
    await render();
    expect(container.textContent).toContain("Link expires 2027-02-01");
    expect(button("Create link")).toBeUndefined();
    expect(button("Create new link")).toBeDefined();
    await act(async () => button("Revoke link")?.click());
    expect(api.send).not.toHaveBeenCalled();
    const [title, , actions] = api.alert.mock.calls[0] as [
      string,
      unknown,
      { text: string; style: string; onPress?: () => void }[],
    ];
    expect(title).toBe("Revoke link?");
    expect(actions.map((a) => [a.text, a.style])).toEqual([
      ["Cancel", "cancel"],
      ["Revoke", "destructive"],
    ]);
    await act(async () => actions[1]?.onPress?.());
    expect(api.send).toHaveBeenCalledWith("dozoBotShares/revoke", { botId: "bot-1" });
    api.send.mockRejectedValue(new Error("Offline"));
    await act(async () => actions[1]?.onPress?.());
    expect(api.alert).toHaveBeenLastCalledWith("Offline");
  });
});
