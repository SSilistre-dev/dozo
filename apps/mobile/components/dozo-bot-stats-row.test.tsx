// @vitest-environment jsdom
import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ui = vi.hoisted(() => ({
  reads: {} as Record<string, unknown>,
  send: vi.fn(),
  share: vi.fn(),
  alert: vi.fn(),
}));

vi.mock("react-native", () => ({ Alert: { alert: ui.alert }, Share: { share: ui.share } }));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("../lib/api/user-error", () => ({
  errorText: (_error: unknown, fallback: string) => fallback,
}));
vi.mock("../lib/query/query", () => ({
  rpcQuery: (path: string) => ({ queryKey: [path], path }),
  // A save that runs at once and reports what it did, as the real one does after its call.
  useSave: (options: {
    save: (input: unknown, send: unknown) => Promise<unknown>;
    onSaved?: (saved: unknown) => void;
    onFailed?: (error: Error) => void;
  }) => ({
    pending: false,
    run: (input: unknown) =>
      options.save(input, ui.send).then(options.onSaved, (error) => options.onFailed?.(error)),
  }),
}));
vi.mock("../lib/query/screen-query", () => ({
  useScreenQuery: (read: { path: string }) => ({ data: ui.reads[read.path] }),
}));
vi.mock("./settings/settings-group", () => ({
  SettingsGroup: ({ children }: { children?: ReactNode }) => <ul>{children}</ul>,
  SettingsRow: ({
    title,
    value,
    onPress,
  }: {
    title: string;
    value?: string;
    onPress?: () => void;
  }) => (
    <li>
      <button type="button" onClick={onPress}>
        {title}
      </button>
      {value ? <b>{value}</b> : null}
    </li>
  ),
}));

import { DozoBotStatsRow } from "./dozo-bot-stats-row";

const STATS = { tasksFinished: 1200, routineRuns: 2, skillsLearned: 0, daysActive: 7 };
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function draw() {
  await act(async () => root.render(<DozoBotStatsRow botId="bot-1" />));
}
const button = (label: string) =>
  [...container.querySelectorAll("button")].find((node) => node.textContent === label);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  root = createRoot(container);
  ui.reads = {};
  ui.send.mockReset();
  ui.share.mockReset();
  ui.alert.mockReset();
});
afterEach(() => act(async () => root.unmount()));

describe("the bot's stats row", () => {
  it("shows nothing until the numbers are read, which a non-owner is refused", async () => {
    await draw();
    expect(container.textContent).toBe("");
  });

  it("shows the four numbers and shares the card through the system sheet", async () => {
    ui.reads = { "dozoBotStats/get": STATS, "dozoShareLinks/list": { links: [] } };
    ui.send.mockResolvedValue({ url: "https://app.example.test/s/token" });
    await draw();
    expect(container.textContent).toContain("1,200");
    expect(container.textContent).toContain("7");
    await act(async () => button("Share card")?.click());
    expect(ui.send).toHaveBeenCalledWith("dozoShareLinks/create", {
      kind: "stats",
      targetId: "bot-1",
      days: 30,
    });
    expect(ui.share).toHaveBeenCalledWith({ url: "https://app.example.test/s/token" });
  });

  it("says when the card could not be made", async () => {
    ui.reads = { "dozoBotStats/get": STATS, "dozoShareLinks/list": { links: [] } };
    ui.send.mockRejectedValue(new Error("no"));
    await draw();
    await act(async () => button("Share card")?.click());
    expect(ui.alert).toHaveBeenCalledWith("Could not share");
  });

  it("stops sharing this bot's cards only", async () => {
    const link = (id: string, kind: string, targetId: string) => ({ id, kind, targetId });
    ui.reads = {
      "dozoBotStats/get": STATS,
      "dozoShareLinks/list": {
        links: [
          link("a", "stats", "bot-1"),
          link("b", "stats", "bot-2"),
          link("c", "other", "bot-1"),
        ],
      },
    };
    ui.send.mockResolvedValue({ revoked: true });
    await draw();
    await act(async () => button("Stop sharing")?.click());
    expect(ui.send).toHaveBeenCalledTimes(1);
    expect(ui.send).toHaveBeenCalledWith("dozoShareLinks/revoke", { id: "a" });
  });

  it("says when sharing could not be stopped", async () => {
    ui.reads = {
      "dozoBotStats/get": STATS,
      "dozoShareLinks/list": { links: [{ id: "a", kind: "stats", targetId: "bot-1" }] },
    };
    ui.send.mockRejectedValue(new Error("no"));
    await draw();
    await act(async () => button("Stop sharing")?.click());
    expect(ui.alert).toHaveBeenCalledWith("Could not save");
  });
});
