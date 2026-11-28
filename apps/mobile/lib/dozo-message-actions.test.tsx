// @vitest-environment jsdom
import { flush } from "@rakazo/core/test-async";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MobileMessage } from "./api/mobile-types";

// Runs on the branded tree: the message procedures exist once the brand rules apply.

const api = vi.hoisted(() => ({
  rpc: vi.fn(),
  alert: vi.fn(),
  rosterReads: [] as (() => unknown)[],
  block: vi.fn(),
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (strings: TemplateStringsArray, ...values: unknown[]) =>
      strings.reduce((text, part, index) => `${text}${values[index - 1] ?? ""}${part}`),
  }),
}));
// A named placeholder shows its value, as the compiled message does.
vi.mock("@lingui/core/macro", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@lingui/core/macro")>()),
  ph: (named: Record<string, unknown>) => Object.values(named)[0],
}));
vi.mock("react-native", () => ({ Alert: { alert: api.alert } }));
vi.mock("./api/api-server", () => ({}));
vi.mock("./auth/api-auth", () => ({}));
vi.mock("./api/api-live", () => ({}));
vi.mock("./api/api", () => ({
  currentApiBase: () => "https://app.example.test",
  selectedSpaceId: () => "space",
  captureApiRequestContext: async () => ({
    apiBase: "https://app.example.test",
    sessionGeneration: 1,
    headers: { "x-rakazo-space-id": "space" },
  }),
  rpc: api.rpc,
}));
vi.mock("./api/session", () => ({ currentSessionGeneration: () => 1 }));
vi.mock("./dozo-blocked-people", () => ({ blockPerson: api.block }));
vi.mock("./api/roster-signals", () => ({
  useRosterSignals: (read: () => unknown, enabled: boolean) => {
    if (enabled) api.rosterReads.push(read);
  },
}));

import type { DozoMessageAction } from "./dozo-message-actions";
import {
  dozoMenuEntries,
  dozoSheetGroups,
  pinLabel,
  setDozoEditOpener,
  setDozoReplayOpener,
  setDozoReportOpener,
  takeEditDraft,
  useDozoChatPins,
  useDozoMessageActions,
} from "./dozo-message-actions";
import { queryClient } from "./query/query";

type Answers = Record<string, unknown>;
let answers: Answers;

function answer(path: string, input?: unknown) {
  const value = answers[path];
  if (value instanceof Error) return Promise.reject(value);
  return Promise.resolve(typeof value === "function" ? value(input) : value);
}

const message = (id: string, extra: Partial<MobileMessage> = {}): MobileMessage =>
  ({
    id,
    threadId: "thread-1",
    role: "user",
    blocks: [{ kind: "text", text: "Hello" }],
    ...extra,
  }) as MobileMessage;

let root: Root;
let container: HTMLDivElement;
let actions: DozoMessageAction[] = [];

function Row({
  m,
  readOnly = false,
  inGroup = false,
  otherAuthor,
}: {
  m: MobileMessage;
  readOnly?: boolean;
  inGroup?: boolean;
  otherAuthor?: { id: string; name: string };
}) {
  actions = useDozoMessageActions(m, readOnly, inGroup, otherAuthor);
  return null;
}

async function render(node: React.ReactNode) {
  await act(async () => root.render(node));
  await act(() => flush());
}

/** Waits for the menu to show these entries. */
const shows = (expected: string[]) =>
  act(() => vi.waitFor(() => expect(names()).toEqual(expected)));

const names = () => actions.map((action) => action.text);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  queryClient.clear();
  api.rpc.mockReset().mockImplementation(answer);
  api.alert.mockReset();
  api.block.mockReset();
  api.rosterReads = [];
  answers = {
    "dozoMessages/revisable": { editMessageId: "m-user", regenerateMessageId: "m-bot" },
    "dozoMessages/pins": { pins: [] },
    "dozoFeedback/status": { mode: null },
  };
  container = document.createElement("div");
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

describe("a message's menu on mobile", () => {
  it("offers Edit on the message the server names, and Pin once the pins are known", async () => {
    await render(<Row m={message("m-user")} />);
    await shows(["Edit", "Pin"]);
    expect(actions.map((action) => [action.symbol, action.icon])).toEqual([
      ["pencil", "create-outline"],
      ["pin", "pin-outline"],
    ]);
  });

  it("offers Regenerate on the bot's reply it names, and nothing else changes elsewhere", async () => {
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Regenerate", "Pin"]);
    await render(<Row m={message("m-other")} />);
    await shows(["Pin"]);
  });

  it("says first, greyed out, which backup wrote a reply, and only on that reply", async () => {
    answers["dozoMessages/revisable"] = {
      editMessageId: null,
      regenerateMessageId: null,
      backupReplies: { "m-bot": "Model B" },
    };
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Answered by Model B", "Pin"]);
    expect(actions[0]).toMatchObject({
      name: "dozoBackup",
      symbol: "info.circle",
      icon: "information-circle-outline",
      disabled: true,
    });
    expect(actions[0]!.onPress()).toBeUndefined();
    await render(<Row m={message("m-other")} />);
    await shows(["Pin"]);
  });

  it("offers Unpin on a pinned message and unpins it", async () => {
    answers["dozoMessages/pins"] = { pins: [{ messageId: "m-other", preview: { text: "Hi" } }] };
    await render(<Row m={message("m-other")} />);
    await shows(["Unpin"]);
    expect(actions.map((action) => [action.symbol, action.icon])).toEqual([["pin.slash", "pin"]]);
    answers["dozoMessages/pin"] = { pinned: false };
    answers["dozoMessages/pins"] = { pins: [] };
    await act(async () => actions[0]!.onPress());
    await shows(["Pin"]);
    expect(api.rpc).toHaveBeenCalledWith(
      "dozoMessages/pin",
      { threadId: "thread-1", messageId: "m-other", pinned: false },
      expect.anything(),
    );
  });

  it("pins, and says why when the server refuses", async () => {
    await render(<Row m={message("m-other")} />);
    await shows(["Pin"]);
    answers["dozoMessages/pin"] = new Error("Not allowed");
    await act(async () => actions[0]!.onPress());
    await vi.waitFor(() => expect(api.alert).toHaveBeenCalledWith("Not allowed"));
  });

  it("regenerates the reply and reads what may change again", async () => {
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Regenerate", "Pin"]);
    answers["dozoMessages/regenerate"] = { runId: "run-2" };
    answers["dozoMessages/revisable"] = { editMessageId: null, regenerateMessageId: null };
    await act(async () => actions[0]!.onPress());
    await shows(["Pin"]);
    expect(api.rpc).toHaveBeenCalledWith(
      "dozoMessages/regenerate",
      { threadId: "thread-1", messageId: "m-bot" },
      expect.anything(),
    );
  });

  it("opens Edit with the message's text, handed over once", async () => {
    const open = vi.fn();
    setDozoEditOpener(open);
    await render(
      <Row
        m={message("m-user", {
          blocks: [
            { kind: "text", text: "First" },
            { kind: "image", name: "a.png" },
            { kind: "text", text: "Second" },
          ] as MobileMessage["blocks"],
        })}
      />,
    );
    await shows(["Edit", "Pin"]);
    actions[0]!.onPress();
    expect(open).toHaveBeenCalledWith("thread-1", "m-user");
    expect(takeEditDraft("m-user")).toEqual({ text: "First\n\nSecond", removes: null });
    expect(takeEditDraft("m-user")).toEqual({ text: "", removes: null });
  });

  it("hands an earlier message's count to Edit, and asks before Regenerate removes the later ones", async () => {
    const open = vi.fn();
    setDozoEditOpener(open);
    answers["dozoMessages/revisable"] = {
      editMessageId: "m-later",
      regenerateMessageId: "m-later-reply",
      earlierEditMessageIds: ["m-user"],
      earlierRegenerateMessageIds: ["m-bot"],
      removedCounts: { "m-user": 3, "m-bot": 2 },
      lastMessageId: "m-later-reply",
    };
    await render(<Row m={message("m-user")} />);
    await shows(["Edit", "Pin"]);
    actions[0]!.onPress();
    // Edit opens at once; its screen asks before Send, told how many go.
    expect(api.alert).not.toHaveBeenCalled();
    expect(open).toHaveBeenCalledWith("thread-1", "m-user");
    expect(takeEditDraft("m-user")).toEqual({
      text: "Hello",
      removes: 3,
      confirmed: { removes: 3, lastMessageId: "m-later-reply" },
    });

    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Regenerate", "Pin"]);
    answers["dozoMessages/regenerate"] = { runId: "run-2" };
    actions[0]!.onPress();
    expect(api.rpc).not.toHaveBeenCalledWith(
      "dozoMessages/regenerate",
      expect.anything(),
      expect.anything(),
    );
    const [title, body, regenerate] = api.alert.mock.calls[0]!;
    expect([title, body]).toEqual(["Remove 2 messages?", undefined]);
    expect(regenerate.map((b: { text: string; style: string }) => [b.text, b.style])).toEqual([
      ["Cancel", "cancel"],
      ["Remove", "destructive"],
    ]);
    await act(async () => regenerate[1].onPress());
    await vi.waitFor(() =>
      expect(api.rpc).toHaveBeenCalledWith(
        "dozoMessages/regenerate",
        {
          threadId: "thread-1",
          messageId: "m-bot",
          confirmed: { removes: 2, lastMessageId: "m-later-reply" },
        },
        expect.anything(),
      ),
    );
  });

  it("asks again with what goes now when the chat changed since the confirm", async () => {
    answers["dozoMessages/revisable"] = {
      editMessageId: null,
      regenerateMessageId: "m-later-reply",
      earlierRegenerateMessageIds: ["m-bot"],
      removedCounts: { "m-bot": 2, "m-later-reply": 1 },
      lastMessageId: "m-later-reply",
    };
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Regenerate", "Pin"]);
    // A turn came and finished meanwhile: the server refuses, and now four go.
    answers["dozoMessages/regenerate"] = Object.assign(
      new Error("This message can no longer be changed."),
      { code: "MESSAGE_NOT_REVISABLE" },
    );
    actions[0]!.onPress();
    answers["dozoMessages/revisable"] = {
      editMessageId: null,
      regenerateMessageId: "m-newest-reply",
      earlierRegenerateMessageIds: ["m-bot"],
      removedCounts: { "m-bot": 4, "m-newest-reply": 1 },
      lastMessageId: "m-newest-reply",
    };
    await act(async () => api.alert.mock.calls[0]![2][1].onPress());
    await vi.waitFor(() => expect(api.alert).toHaveBeenCalledTimes(2));
    const [title, , buttons] = api.alert.mock.calls[1]!;
    expect(title).toBe("Remove 4 messages?");
    answers["dozoMessages/regenerate"] = { runId: "run-2" };
    await act(async () => buttons[1].onPress());
    await vi.waitFor(() =>
      expect(api.rpc).toHaveBeenCalledWith(
        "dozoMessages/regenerate",
        {
          threadId: "thread-1",
          messageId: "m-bot",
          confirmed: { removes: 4, lastMessageId: "m-newest-reply" },
        },
        expect.anything(),
      ),
    );
  });

  it("reads nothing for a message the chat is still writing or one without a chat", async () => {
    await render(<Row m={message("progress:run-1")} />);
    await shows([]);
    await render(<Row m={message("m-user", { threadId: undefined })} />);
    await shows([]);
    expect(api.rpc).not.toHaveBeenCalled();
  });

  it("does not ask what may be edited in a group or a read-only chat, but still pins", async () => {
    await render(<Row m={message("m-user")} inGroup />);
    await shows(["Pin"]);
    await render(<Row m={message("m-user")} readOnly />);
    await shows(["Pin"]);
    expect(api.rpc.mock.calls.map(([path]) => path)).toEqual(["dozoMessages/pins"]);
  });
});

describe("sharing a replay", () => {
  const steps = { blocks: [{ kind: "steps", steps: [{ label: "Browse", count: 1 }] }] };

  it("offers Share replay on a bot's reply with steps, and opens its review", async () => {
    answers["dozoMessages/revisable"] = { editMessageId: null, regenerateMessageId: null };
    const open = vi.fn();
    setDozoReplayOpener(open);
    await render(<Row m={message("m-bot", { role: "bot", runId: "run-1", ...steps } as never)} />);
    await shows(["Pin", "Share replay"]);
    expect([actions[1]!.symbol, actions[1]!.icon]).toEqual(["film", "film-outline"]);
    actions[1]!.onPress();
    expect(open).toHaveBeenCalledWith("m-bot");
  });

  it("offers it nowhere else: a reply without steps, a group, a read-only chat", async () => {
    answers["dozoMessages/revisable"] = { editMessageId: null, regenerateMessageId: null };
    const reply = message("m-bot", { role: "bot", runId: "run-1", ...steps } as never);
    await render(<Row m={message("m-bot", { role: "bot", runId: "run-1" })} />);
    await shows(["Pin"]);
    await render(<Row m={reply} inGroup />);
    await shows(["Pin"]);
    await render(<Row m={reply} readOnly />);
    await shows(["Pin"]);
  });
});

describe("reporting and blocking", () => {
  const ada = { id: "user-ada", name: "Ada" };

  it("offers Report on a bot's reply while the server takes feedback, and opens it for that message", async () => {
    answers["dozoMessages/revisable"] = { editMessageId: null, regenerateMessageId: null };
    answers["dozoFeedback/status"] = { mode: "send" };
    const open = vi.fn();
    setDozoReportOpener(open);
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Pin", "Report"]);
    expect(actions.map((action) => [action.symbol, action.icon]).at(-1)).toEqual([
      "exclamationmark.bubble",
      "flag-outline",
    ]);
    actions.at(-1)!.onPress();
    expect(open).toHaveBeenCalledWith("thread-1", "m-bot");
  });

  it("offers no Report where the server takes no feedback, nor on the person's own message", async () => {
    answers["dozoFeedback/status"] = { mode: null };
    await render(<Row m={message("m-bot", { role: "bot" })} />);
    await shows(["Regenerate", "Pin"]);
    answers["dozoFeedback/status"] = { mode: "save" };
    await render(<Row m={message("m-other")} />);
    await shows(["Pin"]);
    expect(api.rpc.mock.calls.filter(([path]) => path === "dozoFeedback/status")).toHaveLength(1);
  });

  it("offers Report and Block on another member's message; Block asks, then hides them", async () => {
    answers["dozoFeedback/status"] = { mode: "save" };
    await render(<Row m={message("m-other")} inGroup otherAuthor={ada} />);
    await shows(["Pin", "Report", "Block"]);
    expect(actions.map((action) => [action.symbol, action.icon]).at(-1)).toEqual([
      "hand.raised",
      "hand-left-outline",
    ]);
    actions.at(-1)!.onPress();
    expect(api.block).not.toHaveBeenCalled();
    const [title, body, buttons] = api.alert.mock.calls[0] as [
      string,
      string,
      { text: string; style: string; onPress?: () => void }[],
    ];
    expect(title).toMatch(/^Block .*\?$/);
    expect(body).toBe("Their messages are hidden on this phone.");
    expect(buttons.map((entry) => [entry.text, entry.style])).toEqual([
      ["Cancel", "cancel"],
      ["Block", "destructive"],
    ]);
    buttons[1]!.onPress!();
    expect(api.block).toHaveBeenCalledWith("user-ada", "thread-1");
  });
});

describe("the menus' own entries", () => {
  const action: DozoMessageAction = {
    name: "dozoPin",
    text: "Pin",
    symbol: "pin",
    icon: "pin-outline",
    onPress: vi.fn(),
  };

  it("add nothing when there is nothing to offer", () => {
    expect(dozoMenuEntries([])).toEqual([]);
    expect(dozoSheetGroups([])).toEqual([]);
  });

  it("add an inline iOS section with SF Symbols and an Android group", () => {
    expect(dozoMenuEntries([action])).toEqual([
      {
        id: "dozo",
        title: "",
        displayInline: true,
        subactions: [{ id: "dozoPin", title: "Pin", image: "pin" }],
      },
    ]);
    expect(dozoSheetGroups([action])).toEqual([[action]]);
  });

  it("show a line that only says something greyed out in the iOS menu", () => {
    const note: DozoMessageAction = {
      name: "dozoBackup",
      text: "Answered by Model B",
      symbol: "info.circle",
      icon: "information-circle-outline",
      disabled: true,
      onPress: () => undefined,
    };
    expect(dozoMenuEntries([note])[0]?.subactions).toEqual([
      {
        id: "dozoBackup",
        title: "Answered by Model B",
        image: "info.circle",
        attributes: { disabled: true },
      },
    ]);
  });

  it("show that line on Android as a row with its icon, which a tap only closes", () => {
    const note: DozoMessageAction = {
      name: "dozoBackup",
      text: "Answered by Model B",
      symbol: "info.circle",
      icon: "information-circle-outline",
      disabled: true,
      onPress: () => undefined,
    };
    // The Android menu has no greyed row: it draws the line like the others, closes on a tap and
    // runs the line's action, which does nothing (message-action-menu.tsx).
    const [[row]] = dozoSheetGroups([note]) as [[DozoMessageAction]];
    expect(row).toMatchObject({ text: "Answered by Model B", icon: "information-circle-outline" });
    expect(row.onPress()).toBeUndefined();
  });
});

describe("pins", () => {
  it("label a pin by its text, else its file, else its kind", () => {
    const pin = (preview: object) => ({ messageId: "m", preview }) as never;
    expect(pinLabel(pin({ text: "Hi" }), "Page", "Message")).toBe("Hi");
    expect(pinLabel(pin({ text: "", attachment: { name: "a.pdf" } }), "Page", "Message")).toBe(
      "a.pdf",
    );
    expect(pinLabel(pin({ text: "", page: { id: "p" } }), "Page", "Message")).toBe("Page");
    expect(pinLabel(pin({ text: "" }), "Page", "Message")).toBe("Message");
  });

  it("find a bot's or a group's chat and read its pins again on a roster signal", async () => {
    answers["bots/get"] = { threadId: "thread-bot" };
    answers["groups/list"] = [
      { id: "group-other", threadId: "thread-other" },
      { id: "group-1", threadId: "thread-group" },
    ];
    answers["dozoMessages/pins"] = (input: { threadId: string }) => ({
      pins: [{ messageId: `in-${input.threadId}`, preview: { text: "" } }],
    });
    let seen: ReturnType<typeof useDozoChatPins>[] = [];
    function Chats() {
      seen = [useDozoChatPins({ botId: "bot-1" }), useDozoChatPins({ groupId: "group-1" })];
      return null;
    }
    await render(<Chats />);
    await act(() => vi.waitFor(() => expect(seen.every((chat) => chat.pins)).toBe(true)));
    expect(seen.map((chat) => [chat.threadId, chat.pins?.[0]?.messageId])).toEqual([
      ["thread-bot", "in-thread-bot"],
      ["thread-group", "in-thread-group"],
    ]);
    const before = api.rpc.mock.calls.length;
    await act(async () => {
      for (const read of api.rosterReads) await read();
    });
    expect(api.rpc.mock.calls.length).toBeGreaterThan(before);
  });
});
