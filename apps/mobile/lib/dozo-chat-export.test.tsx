import { expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  share: vi.fn(),
  alert: vi.fn(),
  upstream: vi.fn(),
}));

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert }, Share: { share: api.share } }));
vi.mock("./api", () => ({ rpc: api.rpc }));
vi.mock("./user-error", () => ({
  errorText: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));
vi.mock("../components/bot-profile-menu", () => ({
  useBotProfileActions: api.upstream,
  botProfileMenuOptions: () => ({}),
}));

import { botProfileMenuOptions, useBotProfileActions } from "../components/dozo-bot-profile-menu";

const clear = { id: "clear", text: "Clear conversation", destructive: true, onPress: vi.fn() };

it("puts Export before upstream's actions and keeps the header menu as it is", () => {
  api.upstream.mockReturnValueOnce([clear]);
  const actions = useBotProfileActions("bot-1", "Ada");
  expect(api.upstream).toHaveBeenCalledWith("bot-1", "Ada");
  expect(actions.map((action) => action.id)).toEqual(["export", "clear"]);
  expect(actions[0]!.text).toBe("Export");
  expect(botProfileMenuOptions).toBeTypeOf("function");
});

it("hands the chat as the server renders it to the share sheet", async () => {
  api.upstream.mockReturnValueOnce([clear]);
  api.rpc.mockResolvedValueOnce({ markdown: "# Ada\n", truncated: false });
  api.share.mockResolvedValueOnce({ action: "sharedAction" });
  useBotProfileActions("bot-1", "Ada")[0]!.onPress();
  await vi.waitFor(() =>
    expect(api.share).toHaveBeenCalledWith({ message: "# Ada\n", title: "Ada" }),
  );
  expect(api.rpc).toHaveBeenCalledWith("dozoChatExport/markdown", {
    botId: "bot-1",
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
  expect(api.alert).not.toHaveBeenCalled();
});

it("says why when the export fails", async () => {
  api.upstream.mockReturnValueOnce([clear]);
  api.rpc.mockRejectedValueOnce(new Error("Not found"));
  useBotProfileActions("bot-1", "Ada")[0]!.onPress();
  await vi.waitFor(() => expect(api.alert).toHaveBeenCalledWith("Could not export", "Not found"));
  expect(api.share).not.toHaveBeenCalled();
});
