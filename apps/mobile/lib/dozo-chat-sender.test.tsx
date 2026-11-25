// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { hapticSuccess } from "./native/haptics";
import * as feedbackModule from "./thread/send/thread-feedback";

vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./native/haptics", () => ({ hapticImpact: vi.fn(), hapticSuccess: vi.fn() }));
vi.mock("expo-router", () => ({
  useRouter: () => ({ push: vi.fn() }),
  useNavigation: () => ({ isFocused: () => true }),
}));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  currentApiBase: () => "https://app.example",
  rpc: vi.fn(),
  selectedSpaceId: () => null,
}));
vi.mock("./notifications/live-notifications", () => ({ resumeLiveNotifications: async () => undefined }));
vi.mock("./notifications/focus-prompt", () => ({ cancelFocusPrompt: () => undefined }));
vi.mock("./thread/send/unsent-sends", () => ({ prepareUnsentSends: async () => undefined }));
vi.mock("./api/session", () => ({
  loadSessionToken: async () => "token",
  currentSessionGeneration: () => 1,
  registerSessionDiskCache: () => undefined,
}));
vi.mock("./pages/page-runtime", () => ({ loadPageRuntime: async () => "" }));
vi.mock("./notifications/work-activity", () => ({ startWorkActivity: vi.fn() }));

const { useThreadSend } = await import("./thread/send/thread-send");
const { offerPageReply } = await import("./pages/pages");
const { dozoOfferKey } = await import("./dozo-chat-target");
const { offerComposerText } = await import("./composer/composer-offer");

type Sender = ReturnType<typeof useThreadSend>;

/** The chat's sender for a bot's chat: `chatId` makes it one of the bot's extra chats. */
async function chat(chatId?: string) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const payloads: feedbackModule.SendPayload[] = [];
  const threadKey = chatId ?? "bot-1";
  let sender!: Sender;
  let draft = "";
  const feedback = {
    setError: () => undefined,
    sendAttempt: (payload: feedbackModule.SendPayload) => {
      payloads.push(payload);
      return { payload, clientNonce: "n1", artifactIds: new Map(), state: "queued" };
    },
    send: async () => undefined,
  };
  function Harness() {
    sender = useThreadSend({
      botId: "bot-1",
      chatId,
      readOnly: false,
      threadKey,
      history: {
        snapRef: { current: { messages: [] } },
        pinnedAroundRef: { current: null },
        jumpScrollTarget: { current: null },
      },
      scroll: { follow: () => undefined, behavior: { current: { onOwnSend: () => undefined } } },
      feedback,
      attachments: {
        pendingAttachments: [],
        setPendingAttachments: () => undefined,
        setAttachmentNotice: () => undefined,
        importingShare: { current: false },
      },
      mentionBotsRef: { current: [] },
      activeBotId: { current: "bot-1" },
      activeGroupId: { current: undefined },
      isCurrentTarget: () => true,
      refresh: async () => undefined,
      showLatest: () => undefined,
      markCaughtUp: () => undefined,
      openBotChat: () => undefined,
    } as never);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  await act(async () => root.render(createElement(Harness)));
  sender.composerRef.current = {
    snapshot: () => ({
      promptText: draft,
      mentions: [],
      skill: null,
      replyTargetId: sender.replyTarget?.id,
      replyQuote: sender.replyQuote,
      attachmentIds: [],
    }),
    addReply: (text: string) => {
      draft = draft ? `${draft} ${text}` : text;
    },
    reset: () => {
      draft = "";
    },
  } as never;
  /** What the server receives for a message written in the composer. */
  const sent = async (text: string) => {
    sender.composerRef.current?.addReply(text);
    await act(async () => sender.send());
    const payload = payloads.at(-1)!;
    const request = vi.fn(async () => ({ seq: 1 }));
    await feedbackModule.deliverSend(
      payload,
      { clientNonce: "n1", artifactIds: new Map() } as never,
      request as never,
    );
    return { payload, body: (request.mock.calls[0] as unknown[])[1] as Record<string, unknown> };
  };
  return { root, sender: () => sender, sent, threadKey };
}

// The screen hands its chat to the sender, which must name that chat in what it sends and key the
// unsent message, the page reply and the delivery follow-up by that chat, never by its bot.
it("sends in an extra chat as that chat and keys the unsent message by it", async () => {
  const view = await chat("chat-1");
  try {
    const { payload, body } = await view.sent("hello");
    expect(payload.originThreadKey).toBe("chat-1");
    expect(body).toMatchObject({ chatBotId: "bot-1", chatId: "chat-1", text: "hello" });
    expect(body).not.toHaveProperty("botId");
  } finally {
    await act(async () => view.root.unmount());
  }
});

it("sends in a bot's main chat as before", async () => {
  const view = await chat();
  try {
    const { payload, body } = await view.sent("hello");
    expect(payload.originThreadKey).toBe("bot-1");
    expect(body).toMatchObject({ botId: "bot-1", text: "hello" });
    expect(body).not.toHaveProperty("chatId");
  } finally {
    await act(async () => view.root.unmount());
  }
});

it("follows up a delivery only in the chat it was sent from", async () => {
  let delivered!: Parameters<typeof feedbackModule.subscribeDelivered>[0];
  const subscription = vi
    .spyOn(feedbackModule, "subscribeDelivered")
    .mockImplementation((listener) => {
      delivered = listener;
      return () => {};
    });
  const view = await chat("chat-1");
  vi.mocked(hapticSuccess).mockClear();
  try {
    const attempt = (originThreadKey: string) =>
      ({
        payload: { originThreadKey, initialBotTarget: "bot-1", botTarget: "bot-1", plan: {} },
      }) as Parameters<typeof delivered>[0];
    // From the bot's main chat, stacked under this chat: not this chat's.
    delivered(attempt("bot-1"));
    expect(hapticSuccess).not.toHaveBeenCalled();
    delivered(attempt("chat-1"));
    expect(hapticSuccess).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => view.root.unmount());
    subscription.mockRestore();
  }
});

it("takes the offers made to the extra chat's key, and none made to its bot's main chat", async () => {
  const view = await chat("chat-1");
  try {
    // An app card in this chat offers its text under the chat's own key.
    act(() => offerComposerText(dozoOfferKey({ botId: "bot-1" }, "chat-1"), "from the card"));
    expect(view.sender().composerRef.current?.snapshot().promptText).toBe("from the card");
    // One made for the bot's main chat is that chat's, not this one's.
    act(() => offerComposerText(dozoOfferKey({ botId: "bot-1" }, undefined), "for the main chat"));
    expect(view.sender().composerRef.current?.snapshot().promptText).toBe("from the card");
    // A page's reply waiting under the chat's key is taken by it, with the page it is about.
    offerPageReply("chat-1", { text: "reply", page: { id: "page-1", title: "Page" } });
    await act(async () => view.sender().receivePageReply());
    expect(view.sender().composerRef.current?.snapshot().promptText).toContain("reply");
  } finally {
    await act(async () => view.root.unmount());
  }
});
