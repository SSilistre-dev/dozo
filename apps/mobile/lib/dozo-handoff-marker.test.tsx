// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, i) => `${text}${part}${i < values.length ? values[i] : ""}`, ""),
  }),
}));
vi.mock("react-native", () => ({
  StyleSheet: { create: <T,>(styles: T) => styles },
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({
    children,
    accessibilityLabel,
    disabled,
    onPress,
    style,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    disabled?: boolean;
    onPress?: () => void;
    style: (state: { pressed: boolean }) => unknown;
  }) => {
    style({ pressed: false });
    return (
      <button type="button" aria-label={accessibilityLabel} disabled={disabled} onClick={onPress}>
        {children}
      </button>
    );
  },
}));
vi.mock("./appearance/appearance", () => ({ mobileTokens: () => ({ mutedForeground: "muted" }) }));
vi.mock("./native/native", () => ({
  useThemedStyles: (create: () => unknown) => create(),
}));
vi.mock("../components/bots/bot-avatar", () => ({
  BotAvatar: ({ identity, color }: { identity: string; color: string }) => (
    <i data-avatar={identity} data-color={color} />
  ),
}));

import { DozoHandoffMarker } from "../components/thread/dozo-handoff-marker";

const handoff = {
  kind: "handoff" as const,
  fromBotId: "bot-a",
  toBotId: "bot-b",
  text: "Book the flight we picked",
};
const bots = [
  { id: "bot-a", name: "Ada", color: "#111111" },
  { id: "bot-b", name: "Bea", color: "#222222" },
];

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  vi.unstubAllGlobals();
});

const onOpenBot = vi.fn();

async function show(botId: string, known = bots) {
  onOpenBot.mockClear();
  await act(async () =>
    root.render(
      <DozoHandoffMarker
        handoff={handoff}
        botId={botId}
        bots={known}
        onOpenBot={onOpenBot}
        actionProps={{}}
      />,
    ),
  );
  return container.querySelector("button")!;
}

it("opens the next bot's chat from the handing bot's", async () => {
  const button = await show("bot-a");
  expect(button.getAttribute("aria-label")).toBe("Open chat with Bea");
  expect(button.textContent).toBe("↪Bea");
  expect(container.textContent).toContain("Book the flight we picked");
  await act(async () => button.click());
  expect(onOpenBot).toHaveBeenCalledWith("bot-b", "Bea");
});

it("opens the handing bot's chat from the next bot's", async () => {
  const button = await show("bot-b");
  expect(button.textContent).toBe("Ada↪");
  await act(async () => button.click());
  expect(onOpenBot).toHaveBeenCalledWith("bot-a", "Ada");
});

it("offers no way to a bot that is gone", async () => {
  const button = await show("bot-a", []);
  expect(button.disabled).toBe(true);
  expect(container.querySelector("i")?.dataset.color).toBe("muted");
});
