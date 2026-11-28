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
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/ui-web", () => ({
  BotAvatar: ({ identity }: { identity: string }) => <i data-avatar={identity} />,
}));

import { flush } from "@rakazo/core/test-async";
import { DozoHandoffMarker } from "./dozo-handoff-marker-lazy";

await import("./dozo-handoff-marker");

const block = {
  kind: "handoff" as const,
  fromBotId: "bot-a",
  toBotId: "bot-b",
  text: "Book the flight we picked",
};
const bots: Record<string, { name: string; color: string }> = {
  "bot-a": { name: "Ada", color: "#111111" },
  "bot-b": { name: "Bea", color: "#222222" },
};

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

async function show(botId: string, known = bots) {
  const onOpenBot = vi.fn();
  await act(async () =>
    root.render(
      <DozoHandoffMarker
        block={block}
        botId={botId}
        peerBot={(id) => known[id]}
        onOpenBot={onOpenBot}
      />,
    ),
  );
  // The marker's code is already loaded (above), so its lazy wrapper settles on the next turn.
  await act(() => flush());
  return { onOpenBot, button: container.querySelector("button")! };
}

it("leads from the handing bot's chat to the next bot's", async () => {
  const { onOpenBot, button } = await show("bot-a");
  expect(button.getAttribute("aria-label")).toBe("Open chat with Bea");
  expect(button.textContent).toBe("↪Bea");
  expect(container.textContent).toContain("Book the flight we picked");
  await act(async () => button.click());
  expect(onOpenBot).toHaveBeenCalledWith("bot-b");
});

it("leads from the next bot's chat back to the bot that handed it over", async () => {
  const { onOpenBot, button } = await show("bot-b");
  expect(button.textContent).toBe("Ada↪");
  await act(async () => button.click());
  expect(onOpenBot).toHaveBeenCalledWith("bot-a");
});

it("offers no way to a bot that is gone", async () => {
  const { button } = await show("bot-a", {});
  expect(button.disabled).toBe(true);
  expect(button.hasAttribute("aria-label")).toBe(false);
});
