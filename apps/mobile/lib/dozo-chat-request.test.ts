import * as SecureStore from "expo-secure-store";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { jsonResponse, mockSecureStore } from "./api-test-helpers";
import { restoreSessionToken } from "./session";

vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("react-native", () => ({ Platform: { OS: "ios" } }));
vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./live-notifications.js", () => ({
  resumeLiveNotifications: vi.fn(async () => undefined),
  stopLiveNotifications: vi.fn(async () => undefined),
}));
vi.mock("./network-cache.js", () => ({ clearNetworkCache: vi.fn() }));
const avatar = vi.hoisted(() => ({ remember: vi.fn() }));
vi.mock("./logo-avatar-activity", () => ({
  newMobileAvatarSnapshotRequest: () => 1,
  rememberMobileAvatarSnapshot: avatar.remember,
  syncMobileAvatarSession: vi.fn(),
}));

import { promptAiConsent } from "./ai-consent";
import { rpc } from "./api";

beforeEach(async () => {
  vi.mocked(SecureStore.getItemAsync).mockReset();
  mockSecureStore(new Map());
  avatar.remember.mockReset();
  await restoreSessionToken("");
});
afterEach(() => vi.unstubAllGlobals());

const snapshot = { threadId: "chat-1", cursor: 5, botId: "bot-1", messages: [], run: null };

// A message to an extra chat starts the same AI processing as one to its main chat, so the
// person is asked about the same recipients, which the bot's own settings decide.
it("asks consent about an extra chat's bot before a message goes", async () => {
  vi.mocked(promptAiConsent).mockResolvedValue(false);
  const fetchMock = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    jsonResponse({
      json: {
        scope: "account-space",
        version: "2026-09-14",
        recipients: [
          { key: "provider", name: "Example AI", use: "model", detail: "", allowed: false },
        ],
      },
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  await expect(
    rpc("threads/send", { chatBotId: "bot-1", chatId: "chat-1", text: "private content" } as never),
  ).rejects.toThrow("AI data sharing");
  const [[url, init]] = fetchMock.mock.calls;
  expect(String(url)).toContain("/rpc/aiConsent/status");
  expect(JSON.parse(String(init?.body)).json).toEqual({
    uses: ["model", "memory"],
    botId: "bot-1",
  });
  expect(init?.body).not.toContain("private content");
});

it("keeps an extra chat's snapshot from standing in for its bot's main chat's", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => jsonResponse({ json: snapshot })),
  );
  await rpc("threads/get", { chatBotId: "bot-1", chatId: "chat-1" } as never);
  expect(avatar.remember).not.toHaveBeenCalled();
  await rpc("threads/get", { botId: "bot-1" });
  expect(avatar.remember).toHaveBeenCalledOnce();
});
