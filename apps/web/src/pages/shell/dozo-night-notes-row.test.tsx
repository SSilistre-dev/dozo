// @vitest-environment jsdom

import { DOZO_NIGHT_NOTES_ROUTINE_PROMPT } from "@rakazo/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  me: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("../../lib/query/rpc", () => {
  const rpc = {
    routines: { list: api.list, create: api.create, update: api.update },
    me: api.me,
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});
vi.mock("../../lib/dozo-error-text", () => ({ toastError: api.toastError }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray) => strings.join(""),
    i18n: { locale: "en-GB" },
  }),
  Trans: ({ children }: { children: string }) => children,
}));
vi.mock("./bots/bot-settings-sections", () => ({
  SwitchRow: ({
    label,
    checked,
    disabled,
    onChange,
  }: {
    label: string;
    checked: boolean;
    disabled?: boolean;
    onChange: (on: boolean) => void;
  }) => (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      {label}
    </button>
  ),
}));

import { QueryUserProvider } from "../../lib/query/query";
import { DozoNightNotesRow } from "./dozo-night-notes-row";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

const toggle = () => container.querySelector<HTMLButtonElement>("[role=switch]")!;

async function render() {
  await act(async () => {
    root.render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
      >
        <QueryUserProvider value="user-1">
          <DozoNightNotesRow botId="bot-1" />
        </QueryUserProvider>
      </QueryClientProvider>,
    );
  });
  await vi.waitFor(() => expect(toggle()).not.toBeNull());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  api.list.mockReset().mockResolvedValue([]);
  api.create.mockReset().mockResolvedValue({});
  api.update.mockReset().mockResolvedValue({});
  api.me.mockReset().mockResolvedValue({ userId: "user-1", timezone: "Europe/Istanbul" });
  api.toastError.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

describe("DozoNightNotesRow", () => {
  it("switching on creates the daily routine on this bot in the account's zone", async () => {
    await render();
    expect(toggle().getAttribute("aria-checked")).toBe("false");
    await act(async () => toggle().click());
    expect(api.create).toHaveBeenCalledWith(
      expect.objectContaining({
        botId: "bot-1",
        timezone: "Europe/Istanbul",
        active: true,
        crons: ["0 3 * * *"],
        prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT,
      }),
    );
  });

  it("shows a running routine as on and switching off pauses that routine", async () => {
    api.list.mockResolvedValue([
      { id: "r1", prompt: DOZO_NIGHT_NOTES_ROUTINE_PROMPT, active: true },
    ]);
    await render();
    expect(toggle().getAttribute("aria-checked")).toBe("true");
    await act(async () => toggle().click());
    expect(api.update).toHaveBeenCalledWith({ routineId: "r1", active: false });
    expect(api.create).not.toHaveBeenCalled();
  });
});
